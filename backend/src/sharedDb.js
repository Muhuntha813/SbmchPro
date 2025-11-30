import { Pool } from 'pg'
import logger from '../lib/logger.js'

/**
 * Shared Database Pool
 * Single pool instance used across the entire application to prevent connection exhaustion
 */

let pool = null

/**
 * Get or create the shared database pool
 */
export function getSharedPool() {
  if (!pool) {
    const DB_URL = process.env.DATABASE_URL || ''
    if (!DB_URL) {
      throw new Error('DATABASE_URL not configured')
    }

    // Optimize pool settings for Render free tier
    // Supabase free tier: 200 concurrent connections max
    pool = new Pool({
      connectionString: DB_URL,
      ssl: DB_URL.includes('supabase') ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 10000,
      // Limit pool size to prevent connection exhaustion
      max: 10, // Max 10 connections in pool (safe for free tier)
      idleTimeoutMillis: 30000, // Close idle connections after 30s
      allowExitOnIdle: true, // Allow process to exit when pool is idle
    })

    // Handle pool errors
    pool.on('error', (err) => {
      logger.error('[sharedDb] Pool error', { error: err.message, code: err.code })
    })

    pool.on('connect', () => {
      logger.debug('[sharedDb] New connection established')
    })

    logger.info('[sharedDb] Database pool initialized', {
      maxConnections: 10,
      hasDbUrl: !!DB_URL,
    })
  }

  return pool
}

/**
 * Query helper using shared pool
 */
export async function query(text, params) {
  const poolInstance = getSharedPool()
  return poolInstance.query(text, params)
}

/**
 * Get a client from the pool (for transactions)
 */
export async function getClient() {
  const poolInstance = getSharedPool()
  return poolInstance.connect()
}

/**
 * Close the pool (for graceful shutdown)
 */
export async function closePool() {
  if (pool) {
    logger.info('[sharedDb] Closing database pool')
    await pool.end()
    pool = null
  }
}

