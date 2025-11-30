// backend/src/middleware/checkAccess.js
// Simple middleware - just verify token and user exists (free version, no subscription checks)

import { query } from '../db.js'
import logger from '../../lib/logger.js'

/**
 * Check access middleware - simple version for free app
 * Just verifies token and user exists - no subscription checks
 * 
 * @param {Function} verifyToken - Function to verify JWT token
 * @param {Function} getUserById - Function to get user by ID
 * @returns {Function} Express middleware
 */
export function createCheckAccess(verifyToken, getUserById) {
  return async (req, res, next) => {
    try {
      // Verify token
      const auth = req.headers.authorization
      if (!auth || !auth.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'unauthorized', message: 'Missing Authorization header' })
      }
      const token = auth.slice(7)
      const payload = verifyToken(token)
      if (!payload || !payload.userId) {
        return res.status(401).json({ error: 'unauthorized', message: 'Invalid token' })
      }

      // Get user from database
      const user = await getUserById(payload.userId)
      if (!user) {
        return res.status(401).json({ error: 'unauthorized', message: 'User not found' })
      }

      // Free version - always allow access if user exists
      logger.debug('[checkAccess] User verified, allowing access', {
        userId: user.id,
        student_id: user.student_id
      })
      
      return next()
    } catch (err) {
      logger.error('[checkAccess] Error:', { error: err.message, stack: err.stack })
      return res.status(500).json({ 
        error: 'Internal server error', 
        message: 'An error occurred while checking access' 
      })
    }
  }
}

export default { createCheckAccess }
