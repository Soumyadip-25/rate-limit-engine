/**
 * ==============================================================================
 * File: src/routes/api.js
 * Description: API Route definitions for testing and monitoring the Rate Limiter
 * ==============================================================================
 * 
 * Endpoints:
 *   GET /api/test   - Protected by rateLimiter. Returns 200 OK if allowed, 429 if blocked.
 *   GET /api/status - Returns rate limit metrics for the calling client without consuming a slot.
 */

const express = require('express');
const { rateLimiter, getClientIp, getRateLimitStatus } = require('../middleware/rateLimiter');

const router = express.Router();

/**
 * GET /api/test
 * 
 * Protected endpoint. Every incoming request must pass through `rateLimiter`.
 * If allowed, responds with 200 OK and detailed remaining allowance.
 * If exceeded, `rateLimiter` responds with 429 Too Many Requests before reaching this handler.
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
 * Informational endpoint. Inspects the client's current rate limit usage without
 * registering a new request or consuming any quota.
 */
router.get('/status', async (req, res) => {
  const clientIp = getClientIp(req);

  try {
    const status = await getRateLimitStatus(clientIp);

    // Provide informational rate limit headers
    res.setHeader('X-RateLimit-Limit', status.limit);
    res.setHeader('X-RateLimit-Remaining', status.remaining);
    res.setHeader('X-RateLimit-Reset', status.resetTime);

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
