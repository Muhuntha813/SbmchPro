// IMPORTANT: Load dotenv FIRST before accessing process.env
import dotenv from 'dotenv'
import path from 'path'
dotenv.config({
  path: path.resolve(process.cwd(), '.env')
})

import express from 'express'
import rateLimit from 'express-rate-limit'
import axios from 'axios'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { query } from '../src/db.js'
import logger from '../lib/logger.js'
import { triggerScrape } from '../src/services/scraperService.js'

const router = express.Router()

// Auth status endpoint - check if token is valid
router.get('/status', async (req, res) => {
  try {
    const auth = req.headers.authorization || ''
    if (!auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'unauthorized', message: 'Missing Authorization header' })
    }
    
    const token = auth.slice(7).trim()
    if (!token) {
      return res.status(401).json({ error: 'unauthorized', message: 'Empty token' })
    }
    
    // Verify token
    const payload = jwt.verify(token, JWT_SECRET)
    if (!payload || !payload.userId) {
      return res.status(401).json({ error: 'unauthorized', message: 'Invalid token' })
    }
    
    // Check if user exists
    const { rows } = await query('SELECT id, student_id, name FROM users WHERE id = $1', [payload.userId])
    if (rows.length === 0) {
      return res.status(401).json({ error: 'unauthorized', message: 'User not found' })
    }
    
    // Return user status (free version - no subscription checks)
    res.json({
      authenticated: true,
      user: {
        id: rows[0].id,
        student_id: rows[0].student_id,
        name: rows[0].name
      },
      subscription_status: 'active' // Free version - always active
    })
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'unauthorized', message: 'Invalid or expired token' })
    }
    logger.error('[auth/status] Error', { error: err.message })
    res.status(500).json({ error: 'internal_server_error' })
  }
})

// Use JWT_SECRET if set, otherwise SECRET, otherwise dev fallback (same as attendance.js)
const JWT_SECRET = process.env.JWT_SECRET || process.env.SECRET || 'dev-secret-for-local'
logger.info('[auth] JWT secret configured', { 
  hasJwtSecret: !!process.env.JWT_SECRET,
  hasSecret: !!process.env.SECRET,
  secretLength: JWT_SECRET.length,
  usingFallback: !process.env.JWT_SECRET && !process.env.SECRET,
  secretPrefix: JWT_SECRET.substring(0, 10) + '...' // Log first 10 chars for debugging
})
const SCRAPER_URL = process.env.SCRAPER_URL
const SCRAPER_TIMEOUT_MS = Number(process.env.SCRAPER_TIMEOUT_MS || 5000)

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many login attempts; try again in a minute.'
})

function signJwt(payload) {
  if (!JWT_SECRET) throw new Error('server_misconfigured')
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' })
}

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { student_id, password } = req.body || {}
    if (!student_id || typeof student_id !== 'string' || !password || typeof password !== 'string') {
      return res.status(400).json({ error: 'invalid_body' })
    }

    // Check if user exists in database
    const { rows: existingRows } = await query(
      'SELECT id, student_id, password_hash, name, login_count FROM users WHERE student_id = $1 LIMIT 1',
      [student_id]
    )
    const existing = existingRows[0]

    if (existing) {
      // User exists - verify password
      const ok = await bcrypt.compare(password, existing.password_hash)
      if (!ok) return res.status(401).json({ error: 'invalid_credentials' })
      
      // Increment login_count
      logger.debug('[auth/login] Updating login_count', { userId: existing.id })
      const updateResult = await query(
        'UPDATE users SET login_count = login_count + 1, last_login_at = now() WHERE id = $1',
        [existing.id]
      )
      logger.debug('[auth/login] Update result', { 
        rowCount: updateResult.rowCount,
        userId: existing.id 
      })
      
      // Get updated user with new login_count
      const { rows: updatedRows } = await query(
        'SELECT id, student_id, name, login_count, last_login_at FROM users WHERE id = $1',
        [existing.id]
      )
      const updatedUser = updatedRows[0]
      logger.debug('[auth/login] Fetched updated user', { 
        userId: updatedUser.id,
        loginCount: updatedUser.login_count,
        studentId: updatedUser.student_id
      })
      
      const token = signJwt({ userId: updatedUser.id, student_id: updatedUser.student_id })
      
      logger.info('[auth/login] User logged in', { 
        student_id: updatedUser.student_id, 
        login_count: updatedUser.login_count,
        userId: updatedUser.id,
        tokenLength: token.length,
        tokenPrefix: token.substring(0, 20) + '...'
      })
      
      // CRITICAL: Always trigger scraping for existing users
      // Run in background - don't block response
      logger.info('[auth/login] Triggering attendance scrape for existing user', { username: updatedUser.student_id })
      triggerScrape(updatedUser.student_id, password).catch(err => {
        logger.error('[auth/login] [scrape_error] Background scrape failed for existing user', { 
          username: updatedUser.student_id, 
          error: err.message, 
          stack: err.stack,
          errorCode: err.code,
          errorName: err.name
        })
      })
      
      return res.json({
        token,
        user: {
          id: updatedUser.id,
          student_id: updatedUser.student_id,
          name: updatedUser.name || null,
          login_count: updatedUser.login_count,
          last_login_at: updatedUser.last_login_at
        }
      })
    }

    // No user: create user automatically (scraper will verify credentials)
    // If SCRAPER_URL is available, use it for verification; otherwise create user and let scraper verify
    let name = null
    let scraperExists = false
    
    if (SCRAPER_URL) {
      try {
        const resp = await axios.get(`${SCRAPER_URL}/${encodeURIComponent(student_id)}`, { timeout: SCRAPER_TIMEOUT_MS })
        const data = resp?.data || {}
        if (data && typeof data.found === 'boolean') {
          if (data.found === false) {
            await query('INSERT INTO scraper_failures (student_id, ip) VALUES ($1, $2)', [student_id, req.ip || null])
            return res.status(404).json({ error: 'student_not_found' })
          }
          name = data.name || null
          scraperExists = true
        }
      } catch (err) {
        // If scraper verification fails, still create user and let attendance scraper verify
        logger.warn('[auth/login] Scraper verification failed, creating user anyway', { 
          username: student_id, 
          error: err.message 
        })
      }
    }

    // Create user with login_count = 1 (first login)
    const hash = await bcrypt.hash(password, 10)
    const insertSql = `
      INSERT INTO users (student_id, password_hash, name, scraper_checked_at, scraper_exists, login_count, created_at, last_login_at)
      VALUES ($1, $2, $3, now(), $4, 1, now(), now())
      ON CONFLICT (student_id) DO NOTHING
      RETURNING id, student_id, name, login_count, last_login_at
    `
    let user
    try {
      const { rows: created } = await query(insertSql, [student_id, hash, name, scraperExists])
      if (created.length > 0) {
        user = created[0]
        logger.info('[auth/login] Created new user', { student_id: user.student_id, login_count: user.login_count })
      } else {
        // User already exists (race condition), fetch it and increment login_count
        const { rows: existingRows } = await query(
          'SELECT id, student_id, name, login_count FROM users WHERE student_id = $1 LIMIT 1',
          [student_id]
        )
        const existingUser = existingRows[0]
        
        // Increment login_count
        await query(
          'UPDATE users SET login_count = login_count + 1, last_login_at = now() WHERE id = $1',
          [existingUser.id]
        )
        
        // Get updated user
        const { rows: updatedRows } = await query(
          'SELECT id, student_id, name, login_count, last_login_at FROM users WHERE id = $1',
          [existingUser.id]
        )
        user = updatedRows[0]
        logger.info('[auth/login] User logged in (race condition)', { 
          student_id: user.student_id, 
          login_count: user.login_count 
        })
      }
    } catch (err) {
      logger.error('[auth/login] Error creating user', { 
        username: student_id, 
        error: err.message, 
        stack: err.stack 
      })
      return res.status(500).json({ error: 'Internal server error' })
    }
    
    const token = signJwt({ userId: user.id, student_id: user.student_id })
    
    // CRITICAL: Always trigger scraping after user creation/login
    // Run in background - don't block response
    logger.info('[auth/login] Triggering attendance scrape for new user', { username: student_id })
    triggerScrape(student_id, password).catch(err => {
      logger.error('[auth/login] [scrape_error] Background scrape failed for new user', { 
        username: student_id, 
        error: err.message, 
        stack: err.stack,
        errorCode: err.code,
        errorName: err.name
      })
    })
    
    return res.json({ 
      token, 
      user: {
        id: user.id,
        student_id: user.student_id,
        name: user.name || null,
        login_count: user.login_count,
        last_login_at: user.last_login_at
      }
    })
  } catch (err) {
    if (err && err.message === 'server_misconfigured') {
      return res.status(500).json({ error: 'server_misconfigured' })
    }
    return res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
