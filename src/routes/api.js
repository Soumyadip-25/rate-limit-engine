/**
 * ==============================================================================
 * File: src/routes/api.js
 * Description: API Route definitions for testing and monitoring the Rate Limiter
 * ==============================================================================
 * 
 * Endpoints:
 *   GET /api/test   - Protected by main rateLimiter (default: 5 requests / 60 seconds).
 *   GET /api/status - Protected by statusRateLimiter (default: 30 requests / 60 seconds).
 *                     Inspects client's current usage of /api/test without consuming a slot.
 */

const express = require('express');
const {
  rateLimiter,
  statusRateLimiter,
  getClientIp,
  getRateLimitStatus,
} = require('../middleware/rateLimiter');

const router = express.Router();

/**
 * GET /api/test
 * 
 * Protected by main rateLimiter.
 * Allows requests within the configured sliding window limit (default: 5 req / 60s).
 * Rejects requests exceeding the limit with HTTP 429 Too Many Requests.
 */
router.get('/test', rateLimiter, (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Request successful! You are within your rate limit.',
    data: {
      clientIp: req.rateLimit?.clientIp || getClientIp(req),
      limit: req.rateLimit?.limit,
      remaining: req.rateLimit?.remaining,
      currentUsage: req.rateLimit?.currentCount,
      resetTime: req.rateLimit?.resetTime,
      timestamp: new Date().toISOString(),
    },
  });
});

/**
 * GET /api/status
 * 
 * Protected by statusRateLimiter (relaxed rate limiter: 30 req / 60s).
 * Inspects the client's current rate limit usage for /api/test without
 * consuming a slot in the main rate limiter, while preventing Redis DoS.
 */
router.get('/status', statusRateLimiter, async (req, res) => {
  const clientIp = getClientIp(req);

  try {
    const status = await getRateLimitStatus(clientIp);

    res.status(200).json({
      success: true,
      data: status,
    });
  } catch (error) {
    console.error(`[Routes:Status] Failed to retrieve status for IP ${clientIp}:`, error.message);

    res.status(503).json({
      success: false,
      error: 'Service Unavailable',
      message: 'Rate limit information is temporarily unavailable. Please try again later.',
    });
  }
});

module.exports = router;
