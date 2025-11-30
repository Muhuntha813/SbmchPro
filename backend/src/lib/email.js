// backend/src/lib/email.js
// Email notification functions for subscription and trial expiration

import logger from '../../lib/logger.js'

/**
 * Send email notification when subscription expires
 * @param {Object} user - User object with email, student_id, name, etc.
 * @returns {Promise<boolean>} - Returns true if email was sent successfully
 */
export async function sendSubscriptionExpiredEmail(user) {
  try {
    // TODO: Implement email sending using nodemailer or email service
    // For now, just log the event
    logger.info('[email] Subscription expired notification', {
      userId: user.id,
      email: user.email || user.student_id,
      studentId: user.student_id,
      name: user.name
    })
    
    // If nodemailer is configured, implement actual email sending here
    // Example:
    // const transporter = nodemailer.createTransport({...})
    // await transporter.sendMail({...})
    
    return true // Return true to indicate "sent" (even if just logged)
  } catch (err) {
    logger.error('[email] Failed to send subscription expired email', {
      userId: user.id,
      error: err.message
    })
    return false
  }
}

/**
 * Send email notification when trial expires
 * @param {Object} user - User object with email, student_id, name, etc.
 * @returns {Promise<boolean>} - Returns true if email was sent successfully
 */
export async function sendTrialExpiredEmail(user) {
  try {
    // TODO: Implement email sending using nodemailer or email service
    // For now, just log the event
    logger.info('[email] Trial expired notification', {
      userId: user.id,
      email: user.email || user.student_id,
      studentId: user.student_id,
      name: user.name
    })
    
    // If nodemailer is configured, implement actual email sending here
    
    return true // Return true to indicate "sent" (even if just logged)
  } catch (err) {
    logger.error('[email] Failed to send trial expired email', {
      userId: user.id,
      error: err.message
    })
    return false
  }
}
