import logger from '../../lib/logger.js'
import { withBrowser } from './browserPool.js'
import puppeteer from 'puppeteer'
import { existsSync } from 'fs'
import { join } from 'path'

const LOGIN_URL = 'https://sbmchlms.com/lms/site/userlogin'
const ATT_PAGE = 'https://sbmchlms.com/lms/user/attendence'

const sleep = ms => new Promise(res => setTimeout(res, ms))

/**
 * Find Chrome executable path (same logic as browserPool)
 */
function findChromeExecutable() {
  // Check environment variable first
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    if (existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
      return process.env.PUPPETEER_EXECUTABLE_PATH
    }
  }
  
  // Common Puppeteer cache locations
  const possiblePaths = [
    // Render/Linux default
    join(process.env.HOME || '/opt/render', '.cache/puppeteer/chrome'),
    // Alternative Render path
    '/opt/render/.cache/puppeteer/chrome',
    // System Chrome
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
  
  // Try to find Chrome in common locations
  for (const basePath of possiblePaths) {
    const chromeVariants = [
      join(basePath, 'chrome-linux64/chrome'),
      join(basePath, 'chrome/chrome'),
      join(basePath, 'chrome'),
      basePath,
    ]
    
    for (const chromePath of chromeVariants) {
      if (existsSync(chromePath)) {
        logger.info('[datewiseAttendance] Found Chrome at', { path: chromePath })
        return chromePath
      }
    }
  }
  
  return null
}

/**
 * Install Chrome at runtime if not found (for fallback)
 */
async function installChromeIfNeeded() {
  try {
    const cacheDir = process.env.PUPPETEER_CACHE_DIR || 
                     join(process.env.HOME || '/opt/render', '.cache/puppeteer')
    
    logger.info('[datewiseAttendance] Attempting to install Chrome at runtime', { cacheDir })
    
    const fetcher = puppeteer.createBrowserFetcher({
      path: cacheDir
    })
    
    const revision = await fetcher.download()
    logger.info('[datewiseAttendance] Chrome installed successfully', {
      revision: revision.revision,
      executablePath: revision.executablePath,
      folderPath: revision.folderPath
    })
    
    return revision.executablePath
  } catch (err) {
    logger.error('[datewiseAttendance] Failed to install Chrome at runtime', {
      error: err.message,
      cacheDir: process.env.PUPPETEER_CACHE_DIR || '/opt/render/.cache/puppeteer'
    })
    throw err
  }
}

// Track if we're currently installing Chrome to avoid multiple simultaneous installations
let chromeInstallPromise = null

/**
 * Fallback: Direct Puppeteer launch (original method before pooling)
 * Used when browser pool fails
 */
async function scrapeWithDirectPuppeteer({ username, password, dateToFetch }) {
  let browser = null
  
  try {
    logger.info('[datewiseAttendance] Using direct Puppeteer (fallback)', { username, dateToFetch })
    
    // Find Chrome executable
    let chromePath = findChromeExecutable()
    
    // If Chrome not found, try to install it at runtime
    if (!chromePath) {
      logger.warn('[datewiseAttendance] Chrome not found, attempting runtime installation')
      
      // Only install once at a time
      if (!chromeInstallPromise) {
        chromeInstallPromise = installChromeIfNeeded()
      }
      
      try {
        chromePath = await chromeInstallPromise
        chromeInstallPromise = null // Reset after successful installation
        logger.info('[datewiseAttendance] Chrome installed, using path', { path: chromePath })
      } catch (installErr) {
        chromeInstallPromise = null // Reset on failure
        logger.error('[datewiseAttendance] Runtime Chrome installation failed', {
          error: installErr.message,
          suggestion: 'Chrome must be installed during build. Check build logs.'
        })
        // Continue anyway - Puppeteer might still work
      }
    }
    
    const launchOptions = {
      headless: 'new',
      defaultViewport: { width: 1280, height: 900 },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--single-process', // Critical for Render free tier memory limits
        '--memory-pressure-off'
      ],
      protocolTimeout: 18000 // Match page timeout
    }
    
    // Use found Chrome path
    if (chromePath) {
      launchOptions.executablePath = chromePath
      logger.info('[datewiseAttendance] Using Chrome executable path', { path: chromePath })
    } else {
      logger.warn('[datewiseAttendance] Chrome executable not found, Puppeteer will try to auto-detect')
    }
    
    browser = await puppeteer.launch(launchOptions).catch((err) => {
      logger.error('[datewiseAttendance] Puppeteer launch failed in fallback', {
        error: err.message,
        code: err.code,
        chromePath: chromePath || 'not set',
        suggestion: 'Chrome installation may have failed. Check build logs and ensure PUPPETEER_CACHE_DIR is set correctly.'
      })
      throw err
    })

    const page = await browser.newPage()
    // Reduced timeout for Render free tier (30s request limit)
    page.setDefaultTimeout(18000)

    logger.info('[datewiseAttendance] Opening login page')
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' })

    // Login
    await page.waitForSelector('input[name="username"], input#username', { timeout: 10000 })
    await page.type('input[name="username"], input#username', username, { delay: 25 })
    await page.type('input[name="password"], input#password', password, { delay: 25 })

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
      page.click('button[type="submit"], input[type="submit"], button.login, .login-btn')
    ])

    // Quick dashboard check
    const loggedIn = await page.evaluate(() => {
      return !!(document.querySelector('header .user-name') ||
                document.querySelector('h4.mt0') ||
                document.querySelector('.dashboard'))
    })

    if (!loggedIn) {
      logger.warn('[datewiseAttendance] Login may have failed (dashboard marker not found)')
    } else {
      logger.info('[datewiseAttendance] Login successful')
    }

    // Navigate to attendance page
    logger.info('[datewiseAttendance] Navigating to attendance page')
    await page.goto(ATT_PAGE, { waitUntil: 'networkidle2' })
    await sleep(600)

    // Helper to set a date input safely
    const setDateIfExists = async (selector, value) => {
      const el = await page.$(selector)
      if (!el) return false

      await page.click(selector, { clickCount: 3 }).catch(() => {})
      await page.keyboard.down('Control').catch(() => {})
      await page.keyboard.press('KeyA').catch(() => {})
      await page.keyboard.up('Control').catch(() => {})
      await page.keyboard.press('Backspace').catch(() => {})
      await page.type(selector, value, { delay: 20 })
      await page.$eval(selector, node => {
        node.dispatchEvent(new Event('input', { bubbles: true }))
        node.dispatchEvent(new Event('change', { bubbles: true }))
      })
      return true
    }

    await setDateIfExists('#dob', dateToFetch)
    await setDateIfExists('#end_dob', dateToFetch)

    const clickedSearch = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]'))
      for (const b of buttons) {
        const txt = (b.innerText || b.value || '').toLowerCase().trim()
        if (!txt) continue
        if (txt.includes('search') || txt.includes('submit') || txt.includes('go') || txt.includes('filter')) {
          b.click()
          return true
        }
      }
      return false
    })

    if (clickedSearch) {
      logger.info('[datewiseAttendance] Clicked search/filter button')
    }

    // Wait for results
    try {
      await page.waitForFunction(() => {
        const box = document.querySelector('.attendance_result')
        if (!box) return false
        const table = box.querySelector('table')
        if (!table) return false
        return table.querySelectorAll('tbody td').length > 0
      }, { timeout: 20000 })
      logger.info('[datewiseAttendance] Attendance table appeared')
    } catch (e) {
      logger.warn('[datewiseAttendance] Timed out waiting for table rows — table may be empty')
    }

    // Scrape rows
    const rows = await page.evaluate(() => {
      const out = []
      const box = document.querySelector('.attendance_result')
      if (!box) return out
      const table = box.querySelector('table')
      if (!table) return out
      const trs = Array.from(table.querySelectorAll('tbody tr'))
      for (const tr of trs) {
        const tds = Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim())
        if (!tds.length) continue
        out.push({
          subject: tds[0] || '',
          time_from: tds[1] || '',
          time_to: tds[2] || '',
          attendance: tds[3] || ''
        })
      }
      return out
    })

    const result = {
      source: ATT_PAGE,
      date_used: dateToFetch,
      rows
    }

    logger.info('[datewiseAttendance] Scrape completed (direct)', {
      rowCount: rows.length,
      dateUsed: dateToFetch
    })

    setCache(username, dateToFetch, result)
    return result

  } catch (err) {
    logger.error('[datewiseAttendance] Direct Puppeteer error', {
      error: err.message,
      code: err.code,
      username,
      dateToFetch
    })
    throw err
  } finally {
    if (browser) {
      try {
        await browser.close()
      } catch (e) {
        logger.warn('[datewiseAttendance] Error closing browser', { error: e.message })
      }
    }
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
 * Scrapes date-wise attendance from SBMCH LMS using Puppeteer
 * Uses browser pool to reduce RAM usage
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

  // Try browser pool first (optimized), fallback to direct Puppeteer if it fails
  try {
    return await withBrowser(async (browserInfo) => {
      if (!browserInfo || !browserInfo.browser) {
        throw new Error('Browser not available from pool')
      }
      
      const { browser } = browserInfo
      let page = null

      try {
      page = await browser.newPage()
      // Reduced timeout for Render free tier (30s request limit)
      // Set page timeout to 18s to leave buffer for other operations
      page.setDefaultTimeout(18000)

      logger.info('[datewiseAttendance] Opening login page')
      await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' })

      // Login
      await page.waitForSelector('input[name="username"], input#username', { timeout: 10000 })
      await page.type('input[name="username"], input#username', username, { delay: 25 })
      await page.type('input[name="password"], input#password', password, { delay: 25 })

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.click('button[type="submit"], input[type="submit"], button.login, .login-btn')
      ])

      // Quick dashboard check
      const loggedIn = await page.evaluate(() => {
        return !!(document.querySelector('header .user-name') ||
                  document.querySelector('h4.mt0') ||
                  document.querySelector('.dashboard'))
      })

      if (!loggedIn) {
        logger.warn('[datewiseAttendance] Login may have failed (dashboard marker not found)')
      } else {
        logger.info('[datewiseAttendance] Login successful')
      }

      // Navigate to attendance page
      logger.info('[datewiseAttendance] Navigating to attendance page')
      await page.goto(ATT_PAGE, { waitUntil: 'networkidle2' })
      await sleep(600) // Let page JS initialize

      // Helper to set a date input safely
      const setDateIfExists = async (selector, value) => {
        const el = await page.$(selector)
        if (!el) return false

        await page.click(selector, { clickCount: 3 }).catch(() => {})
        
        // Clear
        await page.keyboard.down('Control').catch(() => {})
        await page.keyboard.press('KeyA').catch(() => {})
        await page.keyboard.up('Control').catch(() => {})
        await page.keyboard.press('Backspace').catch(() => {})

        // Type new value
        await page.type(selector, value, { delay: 20 })

        // Dispatch events so site scripts detect change
        await page.$eval(selector, node => {
          node.dispatchEvent(new Event('input', { bubbles: true }))
          node.dispatchEvent(new Event('change', { bubbles: true }))
        })

        return true
      }

      // Attempt to set both possible fields
      await setDateIfExists('#dob', dateToFetch)
      await setDateIfExists('#end_dob', dateToFetch)

      // Click a "Search" button if present
      const clickedSearch = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]'))
        for (const b of buttons) {
          const txt = (b.innerText || b.value || '').toLowerCase().trim()
          if (!txt) continue
          if (txt.includes('search') || txt.includes('submit') || txt.includes('go') || txt.includes('filter')) {
            b.click()
            return true
          }
        }
        return false
      })

      if (clickedSearch) {
        logger.info('[datewiseAttendance] Clicked search/filter button')
      } else {
        logger.info('[datewiseAttendance] No search button clicked; relying on input events')
      }

      // Wait for results container/table
      try {
        await page.waitForFunction(() => {
          const box = document.querySelector('.attendance_result')
          if (!box) return false
          const table = box.querySelector('table')
          if (!table) return false
          return table.querySelectorAll('tbody td').length > 0
        }, { timeout: 20000 })

        logger.info('[datewiseAttendance] Attendance table appeared')
      } catch (e) {
        logger.warn('[datewiseAttendance] Timed out waiting for table rows — table may be empty')
      }

      // Scrape rows
      const rows = await page.evaluate(() => {
        const out = []
        const box = document.querySelector('.attendance_result')
        if (!box) return out

        const table = box.querySelector('table')
        if (!table) return out

        const trs = Array.from(table.querySelectorAll('tbody tr'))
        for (const tr of trs) {
          const tds = Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim())
          if (!tds.length) continue

          const subject = tds[0] || ''
          const time_from = tds[1] || ''
          const time_to = tds[2] || ''
          const attendance = tds[3] || ''

          out.push({ subject, time_from, time_to, attendance })
        }

        return out
      })

      const result = { 
        source: ATT_PAGE, 
        date_used: dateToFetch, 
        rows 
      }

      logger.info('[datewiseAttendance] Scrape completed', {
        rowCount: rows.length,
        dateUsed: dateToFetch,
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
      })
      throw err
      } finally {
        // Close page, but keep browser in pool
        if (page) {
          try {
            await page.close()
          } catch (e) {
            logger.warn('[datewiseAttendance] Error closing page', { error: e.message })
          }
      }
    }
    })
  } catch (err) {
    // Handle browser pool errors - try fallback to direct Puppeteer
    const errorMsg = err.message || String(err) || 'Unknown error'
    
    // Check for browser unavailable errors - try fallback
    if (errorMsg.includes('Browser not available') || 
        errorMsg.includes('ECONNRESET') || 
        errorMsg.includes('read ECONNRESET') ||
        errorMsg.includes('Browser service unavailable') ||
        errorMsg.includes('Puppeteer cannot launch')) {
      logger.warn('[datewiseAttendance] Browser pool failed, trying direct Puppeteer fallback', {
        error: errorMsg,
        code: err.code,
        username,
        dateToFetch
      })
      
      // Try direct Puppeteer as fallback (original method)
      try {
        return await scrapeWithDirectPuppeteer({ username, password, dateToFetch })
      } catch (fallbackErr) {
        logger.error('[datewiseAttendance] Both browser pool and direct Puppeteer failed', {
          poolError: errorMsg,
          fallbackError: fallbackErr.message,
          code: fallbackErr.code,
          username,
          dateToFetch
        })
        throw new Error('Browser service unavailable. Puppeteer cannot launch Chrome. Please check Windows Defender/firewall settings or install Chrome manually.')
      }
    }
    
    // Re-throw other errors with more context
    logger.error('[datewiseAttendance] Unexpected error', {
      error: errorMsg,
      code: err.code,
      stack: err.stack,
      username,
      dateToFetch
    })
    throw err
  }
}

