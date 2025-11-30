import { Pool } from 'pg'

// Read DATABASE_URL dynamically to avoid module load order issues
function getDbUrl() {
  return process.env.DATABASE_URL || ''
}

// Lazy pool initialization - only create when first needed
let pool = null

function getPool() {
  if (!pool) {
    const DB_URL = getDbUrl()
    if (!DB_URL) {
      throw new Error('DATABASE_URL not configured')
    }
    pool = new Pool({
      connectionString: DB_URL,
      ssl: DB_URL.includes('supabase') ? { rejectUnauthorized: false } : false,
      // Connection timeout
      connectionTimeoutMillis: 10000
    })
  }
  return pool
}

export function query(text, params) {
  const DB_URL = getDbUrl()
  if (!DB_URL) {
    return Promise.reject(new Error('DATABASE_URL not configured'))
  }
  
  const poolInstance = getPool()
  
  // Log query for debugging (mask sensitive data)
  const logParams = params ? params.map((p, i) => {
    if (typeof p === 'string' && p.length > 20) return p.substring(0, 10) + '...'
    return p
  }) : []
  console.log('[db] Executing query:', text.substring(0, 100), 'params:', logParams)
  
  return poolInstance.query(text, params)
    .then(result => {
      console.log('[db] Query success:', { 
        rowCount: result.rowCount,
        command: result.command,
        queryPreview: text.substring(0, 50) + '...'
      })
      return result
    })
    .catch(err => {
    // Log database errors for debugging
      console.error('[db] Query error:', err.message, err.code, { query: text.substring(0, 100) })
    // Re-throw with more context
    if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
      throw new Error(`Database connection failed: ${err.message}`)
    }
    throw err
  })
}

export default { query }