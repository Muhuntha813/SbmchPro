import logger from '../../lib/logger.js'
import fetch from 'node-fetch'
import { CookieJar } from 'tough-cookie'
import fetchCookie from 'fetch-cookie'
import * as cheerio from 'cheerio'

const LMS_BASE = 'https://sbmchlms.com/lms'
const LOGIN_URL = `${LMS_BASE}/site/userlogin`
const ATT_PAGE = `${LMS_BASE}/user/attendence`
const ORIGIN = 'https://sbmchlms.com'

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache'
}

function withDefaultHeaders(headers = {}) {
  return { ...DEFAULT_HEADERS, ...headers }
}

function cleanText(value) {
  return (value || '').replace(/\s+/g, ' ').trim()
}

/**
 * Login to LMS using fetch and cookies (similar to scraperService)
 */
async function loginToLms({ username, password }) {
  logger.info('[datewiseAttendance] Starting LMS login', { username })
  const jar = new CookieJar()
  const fetchWithCookies = fetchCookie(fetch, jar)
  const client = (url, options = {}) => {
    const headers = withDefaultHeaders(options.headers)
    return fetchWithCookies(url, { ...options, headers })
  }

  let loginPage
  try {
    loginPage = await client(LOGIN_URL, { method: 'GET' })
    if (!loginPage.ok) {
      throw new Error(`Login page request failed (${loginPage.status})`)
    }
  } catch (err) {
    if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' || err.code === 'ECONNREFUSED') {
      logger.error('[datewiseAttendance] LMS host not reachable', { 
        username, 
        error: err.message, 
        code: err.code,
        host: LOGIN_URL 
      })
      throw new Error(`LMS host not reachable: ${err.message}`)
    }
    throw err
  }
  
  const loginHtml = await loginPage.text()
  const $login = cheerio.load(loginHtml)
  const hiddenInputs = {}
  $login('input[type="hidden"]').each((_, el) => {
    const name = $login(el).attr('name')
    if (!name) return
    hiddenInputs[name] = $login(el).attr('value') ?? ''
  })

  const form = new URLSearchParams()
  form.set('username', username)
  form.set('password', password)
  Object.entries(hiddenInputs).forEach(([key, value]) => form.append(key, value ?? ''))

  const loginResponse = await client(LOGIN_URL, {
    method: 'POST',
    body: form,
    headers: withDefaultHeaders({
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: ORIGIN,
      Referer: LOGIN_URL
    }),
    redirect: 'manual'
  })

  if ([301, 302, 303].includes(loginResponse.status)) {
    const location = loginResponse.headers.get('location')
    if (location) {
      const destination = new URL(location, LOGIN_URL).toString()
      await client(destination, { method: 'GET' })
    }
  } else {
    const body = await loginResponse.text()
    if (!loginResponse.ok || /invalid username|password/i.test(body)) {
      logger.error('[datewiseAttendance] LMS login rejected credentials', { username, status: loginResponse.status })
      throw new Error('Login failed: the LMS rejected the credentials or returned an unexpected response.')
    }
  }

  logger.info('[datewiseAttendance] LMS login successful', { username })
  return { client }
}

/**
 * Parse attendance rows from HTML
 */
function parseDatewiseAttendanceRows(html) {
  if (!html) {
    logger.warn('[datewiseAttendance] Empty HTML provided to parser')
    return []
  }
  
  logger.info('[datewiseAttendance] Parsing HTML for attendance table', {
    htmlLength: html.length,
    hasAttendanceResult: html.includes('attendance_result'),
    hasTable: html.includes('<table'),
    hasTbody: html.includes('<tbody'),
    htmlPreview: html.substring(0, 500)
  })
  
  const $ = cheerio.load(html)
  const rows = []
  
  // Try multiple selectors to find the attendance table
  let table = null
  
  // First try: .attendance_result table (most specific)
  const resultBox = $('.attendance_result')
  if (resultBox.length) {
    table = resultBox.find('table').first()
    logger.info('[datewiseAttendance] Found table in .attendance_result', { 
      resultBoxLength: resultBox.length,
      tableLength: table.length 
    })
  }
  
  // Second try: Any table with tbody
  if (!table || table.length === 0) {
    const tablesWithTbody = $('table tbody').parent()
    if (tablesWithTbody.length) {
      table = tablesWithTbody.first()
      logger.info('[datewiseAttendance] Found table with tbody', { count: tablesWithTbody.length })
    }
  }
  
  // Third try: Any table on the page
  if (!table || table.length === 0) {
    const allTables = $('table')
    if (allTables.length) {
      table = allTables.first()
      logger.info('[datewiseAttendance] Found first table on page', { totalTables: allTables.length })
    }
  }
  
  if (!table || table.length === 0) {
    logger.error('[datewiseAttendance] No attendance table found in result page', {
      htmlLength: html.length,
      hasAttendanceResult: html.includes('attendance_result'),
      hasTable: html.includes('<table'),
      hasTbody: html.includes('<tbody'),
      htmlPreview: html.substring(0, 2000),
      // Check for common error messages
      hasNoRecords: html.includes('No attendance') || html.includes('no records') || html.includes('No data'),
      hasError: html.includes('error') || html.includes('Error')
    })
    return []
  }
  
  // Find all rows in tbody (or all tr if no tbody)
  // IMPORTANT: Regular attendance uses table.find('tbody tr') - be consistent
  const tbody = table.find('tbody')
  let trs = null
  
  if (tbody.length > 0) {
    trs = tbody.find('tr')
    logger.info('[datewiseAttendance] Found table rows in tbody', { 
      rowCount: trs.length,
      hasTbody: true
    })
  } else {
    // No tbody, get all tr elements (skip header row if it's thead)
    const thead = table.find('thead')
    if (thead.length > 0) {
      // Skip thead rows, get only tbody rows (even if no tbody tag)
      trs = table.find('tr').not(thead.find('tr'))
    } else {
      trs = table.find('tr')
    }
    logger.info('[datewiseAttendance] Found table rows (no tbody)', { 
      rowCount: trs.length,
      hasTbody: false,
      hasThead: thead.length > 0
    })
  }
  
  if (!trs || trs.length === 0) {
    logger.error('[datewiseAttendance] No table rows found', {
      tableHtml: table.html()?.substring(0, 1000),
      hasTbody: tbody.length > 0,
      tableStructure: {
        hasThead: table.find('thead').length > 0,
        hasTbody: table.find('tbody').length > 0,
        allTrs: table.find('tr').length
      }
    })
    return []
  }
  
  trs.each((_, tr) => {
    const $tr = $(tr)
    const tds = $tr.find('td')
    
    // Skip header rows or rows with less than 3 cells
    if (tds.length < 3) {
      logger.debug('[datewiseAttendance] Skipping row (too few cells)', { cellCount: tds.length })
      return
    }
    
    // Extract text from each cell - properly clean HTML
    const cells = []
    tds.each((_, td) => {
      const $td = $(td)
      // Get text content, removing all HTML tags and cleaning whitespace
      let text = $td.text() || ''
      // Remove HTML entities and clean up
      text = text.replace(/&nbsp;/g, ' ')
                 .replace(/&amp;/g, '&')
                 .replace(/&lt;/g, '<')
                 .replace(/&gt;/g, '>')
                 .replace(/\s+/g, ' ')
                 .trim()
      cells.push(text)
    })
    
    // Date-wise attendance structure: Subject, Time From, Time To, Attendance Status
    const subject = cleanText(cells[0] || '')
    let time_from = cleanText(cells[1] || '')
    let time_to = cleanText(cells[2] || '')
    let attendance = cleanText(cells[3] || '')
    
    // If we have 4+ cells, use them
    if (cells.length >= 4) {
      time_from = cleanText(cells[1] || '')
      time_to = cleanText(cells[2] || '')
      attendance = cleanText(cells[3] || '')
    } else if (cells.length === 3) {
      // Only 3 cells - might be Subject, Time, Attendance
      time_from = cleanText(cells[1] || '')
      time_to = ''
      attendance = cleanText(cells[2] || '')
    }
    
    // Extract attendance status from the cell HTML if text is empty or contains HTML
    if (!attendance || attendance.includes('<canvas') || attendance.includes('<') || attendance.length < 2) {
      const attendanceCell = $(tds[3] || tds[2] || tds[tds.length - 1])
      const attendanceHtml = attendanceCell.html() || ''
      
      // Look for attendance indicators in the HTML
      if (attendanceHtml.includes('Present') || attendanceHtml.toLowerCase().includes('present')) {
        attendance = 'Present'
      } else if (attendanceHtml.includes('Absent') || attendanceHtml.toLowerCase().includes('absent')) {
        attendance = 'Absent'
      } else if (attendanceHtml.includes('canvas')) {
        // Canvas might indicate a chart - check for data attributes or classes
        const canvas = attendanceCell.find('canvas')
        if (canvas.length) {
          // Check parent or sibling elements for attendance status
          const parent = canvas.parent()
          const statusText = parent.text() || parent.attr('title') || parent.attr('data-status') || ''
          if (statusText.toLowerCase().includes('present')) {
            attendance = 'Present'
          } else if (statusText.toLowerCase().includes('absent')) {
            attendance = 'Absent'
          } else {
            // Default to checking percentage or other indicators
            attendance = 'Present' // If canvas exists, usually means data is present
          }
        } else {
          attendance = 'Unknown'
        }
      } else {
        // Try to extract from text content
        const cellText = attendanceCell.text() || ''
        if (cellText.toLowerCase().includes('present') || cellText.includes('100%') || cellText.match(/\d+%/)) {
          attendance = 'Present'
        } else if (cellText.toLowerCase().includes('absent') || cellText.includes('0%')) {
          attendance = 'Absent'
    } else {
          attendance = cellText || 'Unknown'
        }
      }
    }
    
    // Clean up time_from and time_to - remove HTML artifacts
    time_from = time_from.replace(/<\/?[^>]+(>|$)/g, '').trim()
    time_to = time_to.replace(/<\/?[^>]+(>|$)/g, '').trim()
    
    // Extract time from "No of session Completed \n 1/1" format
    if (time_to.includes('session') || time_to.includes('Completed')) {
      const sessionMatch = time_to.match(/(\d+)\s*\/\s*(\d+)/)
      if (sessionMatch) {
        time_to = `${sessionMatch[1]}/${sessionMatch[2]}`
      }
    }
    
    // Skip empty rows (no subject)
    if (!subject) {
      logger.debug('[datewiseAttendance] Skipping row with no subject')
      return
    }
    
    logger.debug('[datewiseAttendance] Parsed row', { 
      subject, 
      time_from, 
      time_to, 
      attendance,
      cellCount: cells.length
    })
    
    rows.push({
      subject,
      time_from,
      time_to,
      attendance
    })
  })
  
  logger.info('[datewiseAttendance] Parsed attendance rows', { rowCount: rows.length })
  
  return rows
}

/**
 * Fetch date-wise attendance using HTTP requests
 */
async function fetchDatewiseAttendance(client, { dateToFetch }) {
  logger.info('[datewiseAttendance] Fetching attendance page', { dateToFetch })
  
  // First, visit the attendance page to get the form
  const attendancePageResponse = await client(ATT_PAGE, { method: 'GET' })
  if (!attendancePageResponse.ok) {
    throw new Error(`Attendance page request failed (${attendancePageResponse.status})`)
  }
  
  const attendancePageHtml = await attendancePageResponse.text()
  const $page = cheerio.load(attendancePageHtml)
  
  // Check if we're still logged in
  if (/Student Login/i.test(attendancePageHtml) && /Username/i.test(attendancePageHtml)) {
    throw new Error('Session invalid – attendance page returned login page.')
  }
  
  // Log the page HTML structure for debugging
  logger.debug('[datewiseAttendance] Attendance page loaded', {
    hasForm: $page('form').length > 0,
    hasDateInputs: $page('input[name="dob"], input#dob, input[name="end_dob"], input#end_dob').length,
    pageTitle: $page('title').text()
  })
  
  // Look for date input fields to understand the form structure
  const dobInput = $page('input[name="dob"], input#dob').first()
  const endDobInput = $page('input[name="end_dob"], input#end_dob').first()
  
  logger.info('[datewiseAttendance] Found date inputs', {
    dobExists: dobInput.length > 0,
    endDobExists: endDobInput.length > 0,
    dobName: dobInput.attr('name') || dobInput.attr('id'),
    endDobName: endDobInput.attr('name') || endDobInput.attr('id')
  })
  
  // Try to find AJAX endpoint by looking for script tags or data attributes
  // Many LMS systems use AJAX endpoints for date-wise attendance
  let apiEndpoint = null
  
  // Look for common API endpoint patterns in the page (check script tags, data attributes, etc.)
  const pageText = attendancePageHtml
  
  // Look for endpoints in script tags (JavaScript code)
  const scriptTags = $page('script').toArray()
  let foundEndpoints = []
  
  for (const script of scriptTags) {
    const scriptContent = $page(script).html() || ''
    // Look for URL patterns in JavaScript
    const urlPatterns = [
      /['"`](\/user\/attendence\/[^'"`\s]+)['"`]/gi,
      /url\s*[:=]\s*['"`](\/user\/attendence\/[^'"`\s]+)['"`]/gi,
      /ajax\s*\([^)]*['"`](\/user\/attendence\/[^'"`\s]+)['"`]/gi
    ]
    
    for (const pattern of urlPatterns) {
      let match
      while ((match = pattern.exec(scriptContent)) !== null) {
        if (match[1] && !foundEndpoints.includes(match[1])) {
          foundEndpoints.push(match[1])
          logger.info('[datewiseAttendance] Found endpoint in script', { endpoint: match[1] })
        }
      }
    }
  }
  
  // Also check data attributes and form actions
  $page('[data-url], [data-action], [data-endpoint]').each((_, el) => {
    const url = $page(el).attr('data-url') || $page(el).attr('data-action') || $page(el).attr('data-endpoint')
    if (url && url.startsWith('/user/attendence/') && !foundEndpoints.includes(url)) {
      foundEndpoints.push(url)
      logger.info('[datewiseAttendance] Found endpoint in data attribute', { endpoint: url })
    }
  })
  
  // Try common date-wise attendance API endpoints (similar pattern to regular attendance)
  // Regular attendance uses: /user/attendence/subjectgetdaysubattendence
  // It sends: date, end_date, subject
  // For date-wise, it might use the SAME endpoint but with different parameters, or a similar one
  const possibleEndpoints = [
    // Found in page scripts/data (prioritize these)
    ...foundEndpoints.map(e => `${LMS_BASE}${e}`),
    // CRITICAL: Try the SAME endpoint as regular attendance first!
    // It might work with just date/end_date parameters
    `${LMS_BASE}/user/attendence/subjectgetdaysubattendence`,
    // Then try date-wise specific variations
    `${LMS_BASE}/user/attendence/getdatewiseattendence`,
    `${LMS_BASE}/user/attendence/getdatewiseattendance`,
    `${LMS_BASE}/user/attendence/datewiseattendence`,
    `${LMS_BASE}/user/attendence/datewiseattendance`,
    `${LMS_BASE}/user/attendence/getattendencebydate`,
    `${LMS_BASE}/user/attendence/getattendancebydate`,
    `${LMS_BASE}/user/attendence/getdateattendence`,
    `${LMS_BASE}/user/attendence/getdateattendance`,
    // Try variations with "by" like regular attendance
    `${LMS_BASE}/user/attendence/getdatewiseattendenceby`,
    `${LMS_BASE}/user/attendence/getattendencebydatewise`,
    `${LMS_BASE}/user/attendence/ajax`,
    // Try the same page with POST (might handle it server-side)
    ATT_PAGE
  ].filter((v, i, a) => a.indexOf(v) === i) // Remove duplicates
  
  logger.info('[datewiseAttendance] Endpoints to try', { 
    count: possibleEndpoints.length,
    endpoints: possibleEndpoints.slice(0, 5) // Log first 5
  })
  
  // Build payload with date fields
  // IMPORTANT: Regular attendance uses 'date' and 'end_date', so try that pattern first
  const payload = new URLSearchParams()
  
  // First, try the same pattern as regular attendance (date, end_date)
  // Regular attendance API uses: date, end_date, subject
  payload.set('date', dateToFetch)
  payload.set('end_date', dateToFetch)
  logger.info('[datewiseAttendance] Using regular attendance pattern (date, end_date)', { 
    date: dateToFetch,
    end_date: dateToFetch 
  })
  
  // Also try to find actual input fields on the page
  const dateFieldNames = ['dob', 'end_dob', 'date', 'end_date', 'start_date', 'attendance_date', 'attendance_date_from', 'attendance_date_to']
  let foundPageInputs = false
  for (const fieldName of dateFieldNames) {
    const input = $page(`input[name="${fieldName}"], input#${fieldName}`).first()
    if (input.length > 0) {
      // If we find page inputs, add them (but keep date/end_date as primary)
      if (fieldName !== 'date' && fieldName !== 'end_date') {
        payload.set(fieldName, dateToFetch)
      }
      foundPageInputs = true
      logger.info('[datewiseAttendance] Found date input on page', { fieldName, value: dateToFetch })
    }
  }
  
  if (!foundPageInputs) {
    logger.warn('[datewiseAttendance] No date inputs found on page, using API pattern (date, end_date)')
  }
  
  // Get any hidden form fields (CSRF tokens, etc.)
  $page('input[type="hidden"]').each((_, el) => {
    const name = $page(el).attr('name')
    const value = $page(el).attr('value') || ''
    if (name && !payload.has(name)) {
      payload.set(name, value)
      logger.debug('[datewiseAttendance] Added hidden field', { name, value: value.substring(0, 50) })
    }
  })
  
  // IMPORTANT: Regular attendance API also sends 'subject' parameter (empty string = all subjects)
  // For date-wise, we might need to send subject as empty or not send it at all
  // But let's try without it first, then add it if needed
  // payload.set('subject', '') // Uncomment if endpoints fail without it
  
  logger.info('[datewiseAttendance] Payload prepared', { 
    payloadString: payload.toString(),
    endpointCount: possibleEndpoints.length,
    allEndpoints: possibleEndpoints
  })
  
  // CRITICAL: Make sure we actually try to submit the date
  // Don't just parse the initial page - we MUST get a response with the date filter applied
  if (payload.toString() === '') {
    logger.error('[datewiseAttendance] Payload is empty - cannot submit date!', {
      dateToFetch,
      foundInputs: dateFieldNames.map(name => ({
        name,
        found: $page(`input[name="${name}"], input#${name}`).length > 0
      }))
    })
    throw new Error('Cannot determine date field names from page. Payload is empty.')
  }
  
  // Try each possible endpoint
  let lastError = null
  let triedEndpoints = []
  
  logger.info('[datewiseAttendance] Starting endpoint attempts', {
    totalEndpoints: possibleEndpoints.length,
    dateToFetch,
    payload: payload.toString()
  })
  
  for (const endpoint of possibleEndpoints) {
    triedEndpoints.push(endpoint)
    try {
      logger.info('[datewiseAttendance] Trying API endpoint', { 
        endpoint,
        payload: payload.toString(),
        attempt: triedEndpoints.length,
        total: possibleEndpoints.length
      })
      
      const response = await client(endpoint, {
        method: 'POST',
        headers: withDefaultHeaders({
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: ATT_PAGE,
          Accept: 'application/json, text/javascript, */*; q=0.01'
        }),
        body: payload
      })
      
      logger.info('[datewiseAttendance] Endpoint response received', {
        endpoint,
        status: response.status,
        contentType: response.headers.get('content-type')
      })
      
      if (!response.ok) {
        logger.warn('[datewiseAttendance] Endpoint returned non-OK status', { 
          endpoint, 
          status: response.status 
        })
        lastError = new Error(`Request failed with status ${response.status}`)
        continue
      }
      
      // Try to parse as JSON first (common for AJAX endpoints)
      const contentType = response.headers.get('content-type') || ''
      let resultHtml = ''
      let jsonResponse = null
      
      // Always try JSON first (regular attendance API returns JSON)
      try {
        const text = await response.text()
        // Try to parse as JSON
        try {
          jsonResponse = JSON.parse(text)
          logger.info('[datewiseAttendance] Received JSON response', { 
            endpoint,
            hasResultPage: !!jsonResponse.result_page,
            hasHtml: !!jsonResponse.html,
            hasData: !!jsonResponse.data,
            status: jsonResponse.status,
            jsonKeys: Object.keys(jsonResponse),
            jsonPreview: JSON.stringify(jsonResponse).substring(0, 500)
          })
        } catch (parseErr) {
          // Not JSON, treat as HTML
          resultHtml = text
          logger.info('[datewiseAttendance] Received HTML response (not JSON)', {
            endpoint,
            htmlLength: resultHtml.length,
            hasAttendanceResult: resultHtml.includes('attendance_result'),
            hasTable: resultHtml.includes('<table')
          })
        }
      } catch (textErr) {
        logger.error('[datewiseAttendance] Failed to read response text', {
          endpoint,
          error: textErr.message
        })
        continue
      }
      
      // Handle JSON response (like regular attendance API)
      if (jsonResponse) {
        // Some APIs return HTML in a JSON field (like regular attendance)
        if (jsonResponse.result_page) {
          resultHtml = jsonResponse.result_page
          logger.info('[datewiseAttendance] Extracted result_page from JSON', {
            htmlLength: resultHtml.length
          })
        } else if (jsonResponse.html) {
          resultHtml = jsonResponse.html
        } else if (jsonResponse.data) {
          resultHtml = typeof jsonResponse.data === 'string' ? jsonResponse.data : JSON.stringify(jsonResponse.data)
        } else {
          // If JSON doesn't have HTML, try to extract data directly
          if (jsonResponse.rows || jsonResponse.data) {
            const rows = jsonResponse.rows || jsonResponse.data || []
            if (Array.isArray(rows) && rows.length > 0) {
              logger.info('[datewiseAttendance] Found rows in JSON response', { 
                endpoint, 
                rowCount: rows.length 
              })
              return rows
            }
          }
          // If status is not '1', still try to parse result_page if it exists
          if (jsonResponse.status !== '1' && jsonResponse.result_page) {
            resultHtml = jsonResponse.result_page
          } else {
            logger.warn('[datewiseAttendance] JSON response has no parseable data', {
              endpoint,
              jsonKeys: Object.keys(jsonResponse),
              status: jsonResponse.status
            })
            continue
          }
        }
      }
      
      // Parse HTML response (from JSON or direct HTML)
      if (!resultHtml) {
        logger.warn('[datewiseAttendance] No HTML to parse', { endpoint })
        continue
      }
      
      logger.info('[datewiseAttendance] Parsing HTML from response', {
        endpoint,
        htmlLength: resultHtml.length,
        hasAttendanceResult: resultHtml.includes('attendance_result'),
        hasTable: resultHtml.includes('<table'),
        htmlPreview: resultHtml.substring(0, 1000)
      })
      
      const rows = parseDatewiseAttendanceRows(resultHtml)
      
      if (rows.length > 0) {
        logger.info('[datewiseAttendance] Successfully fetched attendance from endpoint', { 
          endpoint, 
          rowCount: rows.length 
        })
        return rows
      } else {
        logger.warn('[datewiseAttendance] No rows found in endpoint response after parsing', { 
          endpoint,
          htmlLength: resultHtml.length,
          hasAttendanceResult: resultHtml.includes('attendance_result'),
          hasTable: resultHtml.includes('<table'),
          htmlPreview: resultHtml.substring(0, 2000)
        })
      }
    } catch (err) {
      logger.warn('[datewiseAttendance] Endpoint request failed', { 
        endpoint, 
        error: err.message,
        stack: err.stack
      })
      lastError = err
      continue
    }
  }
  
  // If all API endpoints failed, try form submission as fallback
  logger.info('[datewiseAttendance] All API endpoints failed, trying form submission', {
    triedEndpoints,
    payload: payload.toString()
  })
  
  const form = $page('form').first()
  const formAction = form.attr('action') || ATT_PAGE
  const formUrl = new URL(formAction, ATT_PAGE).toString()
  
  logger.info('[datewiseAttendance] Submitting form', {
    formUrl,
    formAction,
    payload: payload.toString()
  })
  
  const submitResponse = await client(formUrl, {
    method: 'POST',
    headers: withDefaultHeaders({
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: ATT_PAGE,
      Origin: ORIGIN
    }),
    body: payload
  })
  
  logger.info('[datewiseAttendance] Form submission response', {
    status: submitResponse.status,
    contentType: submitResponse.headers.get('content-type')
  })
  
  if (!submitResponse.ok) {
    logger.error('[datewiseAttendance] Form submission failed', {
      status: submitResponse.status,
      lastError: lastError?.message
    })
    throw lastError || new Error(`Date-wise attendance request failed (${submitResponse.status})`)
  }
  
  const resultHtml = await submitResponse.text()
  
  // CRITICAL: Check if we got the same page back (form submission didn't work)
  const isSamePage = resultHtml.length === attendancePageHtml.length || 
                     (resultHtml.includes('dob') && resultHtml.includes('end_dob') && 
                      !resultHtml.includes('attendance_result'))
  
  if (isSamePage) {
    logger.error('[datewiseAttendance] Form submission returned the same page - form may require JavaScript', {
      htmlLength: resultHtml.length,
      originalLength: attendancePageHtml.length,
      hasDateInputs: resultHtml.includes('dob') && resultHtml.includes('end_dob'),
      hasResults: resultHtml.includes('attendance_result')
    })
    throw new Error('Form submission did not work - the page may require JavaScript to submit the date filter. All endpoints failed.')
  }
  
  logger.info('[datewiseAttendance] Form submission HTML received', {
    htmlLength: resultHtml.length,
    hasAttendanceResult: resultHtml.includes('attendance_result'),
    hasTable: resultHtml.includes('<table'),
    isDifferentFromOriginal: resultHtml.length !== attendancePageHtml.length,
    htmlPreview: resultHtml.substring(0, 1000)
  })
  
  const rows = parseDatewiseAttendanceRows(resultHtml)
  
  if (rows.length === 0) {
    logger.error('[datewiseAttendance] No rows found after form submission', {
      htmlLength: resultHtml.length,
      hasAttendanceResult: resultHtml.includes('attendance_result'),
      hasTable: resultHtml.includes('<table'),
      hasTbody: resultHtml.includes('<tbody'),
      htmlPreview: resultHtml.substring(0, 3000),
      // Check if page says "no records" or similar
      hasNoRecordsMessage: resultHtml.includes('No attendance') || 
                          resultHtml.includes('no records') || 
                          resultHtml.includes('No data') ||
                          resultHtml.includes('not found')
    })
  } else {
    logger.info('[datewiseAttendance] Successfully parsed rows from form submission', {
      rowCount: rows.length
    })
  }
  
  return rows
}

// Simple in-memory cache for datewise attendance (5 minute TTL)
const cache = new Map()
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

/**
 * Get cache key for a request
 */
function getCacheKey(username, dateToFetch) {
  return `datewise:${username}:${dateToFetch}`
}

/**
 * Get cached result if available
 */
function getCached(username, dateToFetch) {
  const key = getCacheKey(username, dateToFetch)
  const cached = cache.get(key)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    logger.info('[datewiseAttendance] Cache hit', { username, dateToFetch })
    return cached.data
  }
  if (cached) {
    cache.delete(key) // Expired
  }
  return null
}

/**
 * Set cache result
 */
function setCache(username, dateToFetch, data) {
  const key = getCacheKey(username, dateToFetch)
  cache.set(key, {
    data,
    timestamp: Date.now(),
  })
  // Clean up old cache entries periodically
  if (cache.size > 100) {
    const now = Date.now()
    for (const [k, v] of cache.entries()) {
      if (now - v.timestamp > CACHE_TTL) {
        cache.delete(k)
      }
    }
  }
}

/**
 * Scrapes date-wise attendance from SBMCH LMS using HTTP requests and Cheerio
 * @param {string} username - Student ID
 * @param {string} password - Password
 * @param {string} dateToFetch - Date in DD-MM-YYYY format
 * @returns {Promise<{source: string, date_used: string, rows: Array}>}
 */
export async function scrapeDatewiseAttendance({ username, password, dateToFetch }) {
  // Check cache first
  const cached = getCached(username, dateToFetch)
  if (cached) {
    return cached
  }

  logger.info('[datewiseAttendance] Starting scrape', { username, dateToFetch })

  try {
    // Login to LMS
    const { client } = await loginToLms({ username, password })
    
    // Fetch date-wise attendance
    logger.info('[datewiseAttendance] Fetching date-wise attendance', { username, dateToFetch })
    const rows = await fetchDatewiseAttendance(client, { dateToFetch })

      const result = { 
        source: ATT_PAGE, 
        date_used: dateToFetch, 
        rows 
      }

      logger.info('[datewiseAttendance] Scrape completed', {
        rowCount: rows.length,
        dateUsed: dateToFetch,
      username
      })

      // Cache the result
      setCache(username, dateToFetch, result)

      return result
    } catch (err) {
      logger.error('[datewiseAttendance] Error during scrape', {
        error: err.message,
        stack: err.stack,
        username,
        dateToFetch,
      code: err.code
    })
    throw err
  }
}

