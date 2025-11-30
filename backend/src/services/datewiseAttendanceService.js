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
  if (!html) return []
  const $ = cheerio.load(html)
  const rows = []
  
  const resultBox = $('.attendance_result')
  const table = resultBox.length ? resultBox.find('table') : $('table')
  
  if (!table.length) {
    logger.warn('[datewiseAttendance] No attendance table found in result page')
    return []
  }
  
  table.find('tbody tr').each((_, tr) => {
    const $tr = $(tr)
    const tds = $tr.find('td')
    if (tds.length < 4) return
    
    const subject = cleanText($(tds[0]).text())
    const time_from = cleanText($(tds[1]).text())
    const time_to = cleanText($(tds[2]).text())
    const attendance = cleanText($(tds[3]).text())
    
    rows.push({
      subject,
      time_from,
      time_to,
      attendance
    })
  })
  
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
  
  // Try to find the form and submit it with the date
  // Look for form action or try to submit via API endpoint
  // First, try to find if there's an API endpoint for date-wise attendance
  const form = $page('form')
  let formAction = form.attr('action') || ''
  
  // If no form action, try common API patterns
  if (!formAction || formAction === '#') {
    // Try common date-wise attendance API endpoints
    const possibleEndpoints = [
      `${LMS_BASE}/user/attendence/getdatewiseattendence`,
      `${LMS_BASE}/user/attendence/getdatewiseattendance`,
      `${LMS_BASE}/user/attendence/datewise`,
      `${LMS_BASE}/user/attendence/submit`,
      ATT_PAGE // Fallback to same page
    ]
    
    // Try submitting to the attendance page with form data
    const payload = new URLSearchParams()
    payload.set('dob', dateToFetch)
    payload.set('end_dob', dateToFetch)
    
    // Get any hidden form fields
    $page('input[type="hidden"]').each((_, el) => {
      const name = $page(el).attr('name')
      const value = $page(el).attr('value') || ''
      if (name) {
        payload.set(name, value)
      }
    })
    
    // Try submitting to the attendance page
    const submitResponse = await client(ATT_PAGE, {
      method: 'POST',
      headers: withDefaultHeaders({
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: ATT_PAGE,
        Origin: ORIGIN
      }),
      body: payload
    })
    
    if (!submitResponse.ok) {
      throw new Error(`Date-wise attendance request failed (${submitResponse.status})`)
    }
    
    const resultHtml = await submitResponse.text()
    const rows = parseDatewiseAttendanceRows(resultHtml)
    
    return rows
  } else {
    // Use the form action
    const formUrl = new URL(formAction, ATT_PAGE).toString()
    const payload = new URLSearchParams()
    payload.set('dob', dateToFetch)
    payload.set('end_dob', dateToFetch)
    
    // Get all form fields
    $page('form input').each((_, el) => {
      const name = $page(el).attr('name')
      const type = $page(el).attr('type')
      const value = $page(el).attr('value') || ''
      
      if (name && type !== 'submit' && type !== 'button') {
        if (type === 'hidden' || name === 'dob' || name === 'end_dob') {
          payload.set(name, value || (name.includes('dob') ? dateToFetch : value))
        }
      }
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
    
    if (!submitResponse.ok) {
      throw new Error(`Date-wise attendance form submission failed (${submitResponse.status})`)
    }
    
    const resultHtml = await submitResponse.text()
    const rows = parseDatewiseAttendanceRows(resultHtml)
    
    return rows
  }
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

