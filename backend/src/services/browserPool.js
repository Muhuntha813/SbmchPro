import puppeteer from 'puppeteer'
import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import logger from '../../lib/logger.js'

/**
 * Browser Pool Manager for Puppeteer
 * Reuses browser instances to reduce RAM usage
 * Limits concurrent browsers to prevent OOM on Render free tier
 */

const MAX_BROWSERS = 2 // Maximum concurrent browser instances (for 512MB RAM limit)
const BROWSER_IDLE_TIMEOUT = 60000 // Close idle browsers after 60 seconds
const MAX_PAGES_PER_BROWSER = 3 // Maximum pages per browser before recycling

// Browser pool state
const browserPool = []
const activeBrowsers = new Set()
let queue = []
let processingQueue = false

/**
 * Get optimized Puppeteer launch arguments for low memory usage
 */
function getLaunchArgs() {
  return [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage', // Overcome limited resource problems
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-breakpad',
    '--disable-component-extensions-with-background-pages',
    '--disable-default-apps',
    '--disable-features=TranslateUI',
    '--disable-hang-monitor',
    '--disable-ipc-flooding-protection',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-renderer-backgrounding',
    '--disable-sync',
    '--disable-web-resources',
    '--metrics-recording-only',
    '--no-first-run',
    '--no-default-browser-check',
    '--safebrowsing-disable-auto-update',
    '--enable-automation',
    '--password-store=basic',
    '--use-mock-keychain',
    '--single-process', // Critical: Run in single process to save RAM (may reduce stability slightly)
    '--memory-pressure-off', // Disable memory pressure handling
  ]
}

/**
 * Find Chrome executable path
 */
function findChromeExecutable() {
  // Check environment variable first
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    if (existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
      return process.env.PUPPETEER_EXECUTABLE_PATH
    }
  }
  
  // Common Puppeteer cache locations (Puppeteer v24+ installs to specific subdirectories)
  const cacheDir = process.env.PUPPETEER_CACHE_DIR || 
                   join(process.env.HOME || '/opt/render', '.cache/puppeteer')
  
  const possiblePaths = [
    // Puppeteer v24+ default installation path (from build logs)
    join(cacheDir, 'chrome/linux-142.0.7444.175/chrome-linux64/chrome'),
    // Alternative version paths (check common versions)
    join(cacheDir, 'chrome/linux-*/chrome-linux64/chrome'),
    // Legacy paths
    join(cacheDir, 'chrome/chrome-linux64/chrome'),
    join(cacheDir, 'chrome/chrome'),
    join(cacheDir, 'chrome'),
    // System Chrome
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    // Node modules path
    join(process.cwd(), 'node_modules/puppeteer/.local-chromium'),
  ]
  
  // Try to find Chrome in common locations
  for (const chromePath of possiblePaths) {
    // Handle glob patterns by checking parent directory
    if (chromePath.includes('*')) {
      try {
        const parentDir = chromePath.substring(0, chromePath.indexOf('*'))
        const parentPath = parentDir.substring(0, parentDir.lastIndexOf('/'))
        if (existsSync(parentPath)) {
          const dirs = readdirSync(parentPath)
          for (const dir of dirs) {
            const testPath = join(parentPath, dir, 'chrome-linux64/chrome')
            if (existsSync(testPath)) {
              logger.info('[browserPool] Found Chrome at', { path: testPath })
              return testPath
            }
          }
        }
      } catch (e) {
        // Continue to next path
      }
    } else if (existsSync(chromePath)) {
      logger.info('[browserPool] Found Chrome at', { path: chromePath })
      return chromePath
    }
  }
  
  // Try to find Chrome by scanning the cache directory
  try {
    const chromeCacheDir = join(cacheDir, 'chrome')
    if (existsSync(chromeCacheDir)) {
      // Look for version directories
      const entries = readdirSync(chromeCacheDir)
      for (const entry of entries) {
        const entryPath = join(chromeCacheDir, entry)
        const stats = statSync(entryPath)
        if (stats.isDirectory()) {
          // Check for chrome-linux64 subdirectory
          const chromeLinuxPath = join(entryPath, 'chrome-linux64/chrome')
          if (existsSync(chromeLinuxPath)) {
            logger.info('[browserPool] Found Chrome by scanning cache', { path: chromeLinuxPath })
            return chromeLinuxPath
          }
        }
      }
    }
  } catch (e) {
    logger.debug('[browserPool] Error scanning cache directory', { error: e.message })
  }
  
  return null
}

// Note: Chrome should be installed during build via postinstall script
// Runtime installation is not supported in Puppeteer v24+ without createBrowserFetcher

/**
 * Create a new browser instance
 */
async function createBrowser() {
  try {
    logger.info('[browserPool] Creating new browser instance')
    
    // Find Chrome executable (should be installed during build)
    const chromePath = findChromeExecutable()
    
    if (!chromePath) {
      logger.warn('[browserPool] Chrome executable not found', {
        suggestion: 'Chrome should be installed during build. Check build logs for installation errors.',
        cacheDir: process.env.PUPPETEER_CACHE_DIR || '/opt/render/.cache/puppeteer'
      })
    }
    
    // Configure executable path for Render (if Chrome is installed via postinstall)
    const launchOptions = {
      headless: 'new',
      defaultViewport: { width: 1280, height: 900 },
      args: getLaunchArgs(),
      // Reduce memory usage
      protocolTimeout: 30000,
      // Handle connection errors gracefully
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    }
    
    // Use found Chrome path
    if (chromePath) {
      launchOptions.executablePath = chromePath
      logger.info('[browserPool] Using Chrome executable path', { path: chromePath })
    } else {
      logger.warn('[browserPool] Chrome executable not found, Puppeteer will try to auto-detect')
      logger.info('[browserPool] Cache directory', { 
        cacheDir: process.env.PUPPETEER_CACHE_DIR || 'default',
        home: process.env.HOME || 'not set'
      })
    }
    
    const browser = await puppeteer.launch(launchOptions).catch((err) => {
      logger.error('[browserPool] Puppeteer launch failed', { 
        error: err.message, 
        code: err.code,
        message: err.message,
        chromePath: chromePath || 'not set'
      })
      
      // If Chrome not found, provide helpful error
      if (err.message?.includes('Could not find Chrome') || err.message?.includes('Chrome')) {
        logger.error('[browserPool] Chrome not found after installation attempt', {
          suggestion: 'Chrome installation may have failed. Check build logs and ensure PUPPETEER_CACHE_DIR is set correctly.',
          cacheDir: process.env.PUPPETEER_CACHE_DIR || '/opt/render/.cache/puppeteer',
          home: process.env.HOME || 'not set'
        })
      }
      
      throw err
    })

    const browserInfo = {
      browser,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      pageCount: 0,
      id: Math.random().toString(36).substring(7),
    }

    // Track browser lifecycle
    browser.on('disconnected', () => {
      logger.info('[browserPool] Browser disconnected', { id: browserInfo.id })
      activeBrowsers.delete(browserInfo.id)
      const index = browserPool.findIndex(b => b.id === browserInfo.id)
      if (index !== -1) {
        browserPool.splice(index, 1)
      }
    })

    activeBrowsers.add(browserInfo.id)
    browserPool.push(browserInfo)

    logger.info('[browserPool] Browser created', {
      id: browserInfo.id,
      poolSize: browserPool.length,
      activeCount: activeBrowsers.size,
    })

    return browserInfo
  } catch (err) {
    logger.error('[browserPool] Failed to create browser', { 
      error: err.message, 
      code: err.code,
      name: err.name
    })
    
    // For ECONNRESET on Windows, this is usually a Puppeteer/Chrome download issue
    if (err.code === 'ECONNRESET' || err.message?.includes('ECONNRESET')) {
      logger.error('[browserPool] ECONNRESET error - Puppeteer cannot connect to Chrome. This may be due to:', {
        issue1: 'Chrome/Chromium not installed or not in PATH',
        issue2: 'Windows firewall/antivirus blocking Puppeteer',
        issue3: 'Network issues preventing Chrome download',
        suggestion: 'Try installing Chrome manually or check Windows Defender settings'
      })
    }
    
    // Don't throw - return null so caller can handle gracefully
    // This prevents server crashes
    return null
  }
}

/**
 * Get an available browser from the pool or create a new one
 */
async function acquireBrowser() {
  try {
    // Clean up idle browsers first
    await cleanupIdleBrowsers().catch((err) => {
      logger.warn('[browserPool] Error cleaning up idle browsers', { error: err.message })
    })

    // Find an available browser with capacity
    const availableBrowser = browserPool.find(
      (b) => b.pageCount < MAX_PAGES_PER_BROWSER && activeBrowsers.has(b.id)
    )

    if (availableBrowser) {
      availableBrowser.lastUsedAt = Date.now()
      availableBrowser.pageCount++
      logger.debug('[browserPool] Reusing browser', {
        id: availableBrowser.id,
        pageCount: availableBrowser.pageCount,
      })
      return availableBrowser
    }

    // Check if we can create a new browser
    if (activeBrowsers.size < MAX_BROWSERS) {
      const newBrowser = await createBrowser()
      if (newBrowser) {
        newBrowser.pageCount = 1
        return newBrowser
      } else {
        // Browser creation failed, but don't crash
        logger.warn('[browserPool] Browser creation returned null, will queue request')
        return null
      }
    }

    // No browser available, return null (caller should queue)
    return null
  } catch (err) {
    logger.error('[browserPool] Error in acquireBrowser', { error: err.message })
    return null // Return null instead of throwing to prevent crashes
  }
}

/**
 * Release a browser back to the pool
 */
function releaseBrowser(browserInfo) {
  if (!browserInfo) return

  browserInfo.pageCount = Math.max(0, browserInfo.pageCount - 1)
  browserInfo.lastUsedAt = Date.now()

  logger.debug('[browserPool] Browser released', {
    id: browserInfo.id,
    pageCount: browserInfo.pageCount,
  })

  // If browser has too many pages or is old, recycle it
  if (browserInfo.pageCount >= MAX_PAGES_PER_BROWSER) {
    logger.info('[browserPool] Recycling browser (max pages reached)', {
      id: browserInfo.id,
    })
    recycleBrowser(browserInfo)
  }
}

/**
 * Clean up idle browsers
 */
async function cleanupIdleBrowsers() {
  const now = Date.now()
  const browsersToClose = browserPool.filter(
    (b) =>
      now - b.lastUsedAt > BROWSER_IDLE_TIMEOUT &&
      b.pageCount === 0 &&
      activeBrowsers.has(b.id)
  )

  for (const browserInfo of browsersToClose) {
    await recycleBrowser(browserInfo)
  }
}

/**
 * Recycle (close and remove) a browser
 */
async function recycleBrowser(browserInfo) {
  if (!browserInfo || !browserInfo.browser) return

  try {
    logger.info('[browserPool] Recycling browser', { id: browserInfo.id })
    await browserInfo.browser.close()
  } catch (err) {
    logger.warn('[browserPool] Error closing browser', {
      id: browserInfo.id,
      error: err.message,
    })
  } finally {
    activeBrowsers.delete(browserInfo.id)
    const index = browserPool.findIndex((b) => b.id === browserInfo.id)
    if (index !== -1) {
      browserPool.splice(index, 1)
    }
  }
}

/**
 * Process queued requests
 */
async function processQueue() {
  if (processingQueue || queue.length === 0) return

  processingQueue = true

  try {
    let consecutiveFailures = 0
    const MAX_CONSECUTIVE_FAILURES = 3 // Stop retrying after 3 failures
    
    while (queue.length > 0) {
      const browserInfo = await acquireBrowser()

      if (!browserInfo) {
        consecutiveFailures++
        
        // If we've failed too many times, reject all queued requests
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          logger.error('[browserPool] Too many consecutive failures, rejecting queued requests', {
            queueLength: queue.length,
            failures: consecutiveFailures
          })
          
          // Reject all remaining requests
          while (queue.length > 0) {
            const { resolve } = queue.shift()
            resolve(Promise.reject(new Error('Browser service unavailable. Puppeteer cannot launch Chrome. Please check your system configuration.')))
          }
          break
        }
        
        // Wait with exponential backoff
        const waitTime = Math.min(1000 * Math.pow(2, consecutiveFailures - 1), 5000)
        logger.warn('[browserPool] Browser creation failed, retrying...', {
          attempt: consecutiveFailures,
          waitMs: waitTime,
          queueLength: queue.length
        })
        await new Promise((resolve) => setTimeout(resolve, waitTime))
        continue
      }

      // Reset failure counter on success
      consecutiveFailures = 0
      const { resolve, task } = queue.shift()

      // Execute task with browser
      task(browserInfo)
        .then((result) => {
          releaseBrowser(browserInfo)
          resolve(result)
        })
        .catch((err) => {
          releaseBrowser(browserInfo)
          // If browser error, recycle it
          if (err.message?.includes('Target closed') || err.message?.includes('Session closed') || err.message?.includes('ECONNRESET')) {
            recycleBrowser(browserInfo).catch(() => {}) // Ignore recycle errors
          }
          resolve(Promise.reject(err))
        })
    }
  } catch (err) {
    logger.error('[browserPool] Error in processQueue', { error: err.message })
  } finally {
    processingQueue = false
  }
}

/**
 * Execute a task with a browser from the pool
 * Queues the request if no browser is available
 */
export async function withBrowser(task) {
  return new Promise(async (resolve, reject) => {
    try {
      const browserInfo = await acquireBrowser()

      if (browserInfo) {
        // Browser available, execute immediately
        task(browserInfo)
          .then((result) => {
            releaseBrowser(browserInfo)
            resolve(result)
          })
          .catch((err) => {
            releaseBrowser(browserInfo)
            // If browser error, recycle it
            if (err.message?.includes('Target closed') || err.message?.includes('Session closed') || err.message?.includes('ECONNRESET')) {
              recycleBrowser(browserInfo).catch(() => {}) // Ignore recycle errors
            }
            reject(err)
          })
      } else {
        // No browser available, queue the request
        logger.info('[browserPool] Queueing request (no browser available)', {
          queueLength: queue.length + 1,
        })
        queue.push({
          resolve,
          task,
        })
        processQueue().catch((err) => {
          logger.error('[browserPool] Error processing queue', { error: err.message })
        })
      }
    } catch (err) {
      logger.error('[browserPool] Error in withBrowser', { error: err.message, stack: err.stack })
      reject(err)
    }
  })
}

/**
 * Get pool statistics
 */
export function getPoolStats() {
  return {
    poolSize: browserPool.length,
    activeBrowsers: activeBrowsers.size,
    queueLength: queue.length,
    maxBrowsers: MAX_BROWSERS,
    maxPagesPerBrowser: MAX_PAGES_PER_BROWSER,
  }
}

/**
 * Cleanup all browsers (for graceful shutdown)
 */
export async function cleanup() {
  logger.info('[browserPool] Cleaning up all browsers', {
    count: browserPool.length,
  })

  await Promise.all(browserPool.map((b) => recycleBrowser(b)))
  queue = []
}

// Periodic cleanup of idle browsers
setInterval(() => {
  cleanupIdleBrowsers().catch((err) => {
    logger.error('[browserPool] Error in periodic cleanup', { error: err.message })
  })
}, 30000) // Every 30 seconds

