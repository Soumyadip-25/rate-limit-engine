/**
 * ==============================================================================
 * File: src/middleware/rateLimiter.js
 * Description: Sliding Window Log Rate Limiting Middleware using Redis Sorted Sets
 * ==============================================================================
 * 
 * Algorithm: Sliding Window Log
 *   Maintains a chronological log of timestamps in a Redis Sorted Set (ZSET).
 *   On each incoming request:
 *     1. Purges timestamps older than (currentTime - windowDuration).
 *     2. Counts remaining timestamps within the sliding window.
 *     3. If count < limit: Adds the request timestamp atomically and allows it through.
 *     4. If count >= limit: Blocks the request with HTTP 429 (Too Many Requests).
 * 
 * Concurrency Safety:
 *   Operations execute atomically inside Redis via a pre-compiled Lua script.
 *   Request member identifiers combine timestamp and random UUID (${now}:${uuid})
 *   to eliminate member collisions when requests arrive in the exact same millisecond.
 */

const crypto = require('crypto');
const { redis, isRedisReady } = require('../config/redis');

/**
 * Validates and parses environment variables expecting a strictly positive integer.
 * Avoids the 'parseInt() || default' bug which incorrectly treats 0 as missing.
 * 
 * @param {string|number|undefined} val Raw environment variable value
 * @param {number} defaultVal Safe documented fallback value
 * @param {string} varName Name of variable for diagnostic logging
 * @returns {number} Valid positive integer
 */
function parsePositiveInteger(val, defaultVal, varName) {
  if (val === undefined || val === null || String(val).trim() === '') {
    return defaultVal;
  }

  const parsed = Number(val);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(
      `[ConfigWarning] Variable ${varName} must be a positive integer. ` +
      `Received: "${val}". Falling back to safe default: ${defaultVal}.`
    );
    return defaultVal;
  }

  return parsed;
}

// Configuration options with robust validation
const MAX_REQUESTS = parsePositiveInteger(process.env.RATE_LIMIT_MAX_REQUESTS, 5, 'RATE_LIMIT_MAX_REQUESTS');
const WINDOW_SECONDS = parsePositiveInteger(process.env.RATE_LIMIT_WINDOW_SECONDS, 60, 'RATE_LIMIT_WINDOW_SECONDS');
const WINDOW_MS = WINDOW_SECONDS * 1000;

// Separate relaxed configuration for monitoring/status endpoints
const STATUS_MAX_REQUESTS = parsePositiveInteger(process.env.STATUS_LIMIT_MAX_REQUESTS, 30, 'STATUS_LIMIT_MAX_REQUESTS');
const STATUS_WINDOW_SECONDS = parsePositiveInteger(process.env.STATUS_LIMIT_WINDOW_SECONDS, 60, 'STATUS_LIMIT_WINDOW_SECONDS');

/**
 * Safely extracts and normalizes the client IP address.
 * 
 * Proxy Handling:
 *   Relies on Express's req.ip which respects the application's 'trust proxy' setting.
 *   If trust proxy is false, Express uses the direct TCP socket address (req.socket.remoteAddress),
 *   completely ignoring spoofed X-Forwarded-For headers from untrusted clients.
 * 
 * IP Normalization:
 *   - Strips IPv4-mapped IPv6 prefixes (e.g. '::ffff:127.0.0.1' -> '127.0.0.1').
 *   - Normalizes IPv6 loopback ('::1' -> '127.0.0.1').
 *   - Preserves standard IPv4 and IPv6 strings.
 * 
 * IPv6 Subnet Note:
 *   In enterprise production, IPv6 clients may rotate the host identifier bits
 *   within a /64 allocation. For this academic project, exact client IP identification
 *   is preserved without external parsing dependencies, avoiding collateral blocking
 *   of entire residential subnets.
 * 
 * @param {import('express').Request} req
 * @returns {string} Sanitized client IP address
 */
function getClientIp(req) {
  let ip = req.ip || req.socket?.remoteAddress || '127.0.0.1';

  // Normalize IPv4-mapped IPv6 addresses
  if (ip.startsWith('::ffff:')) {
    ip = ip.replace('::ffff:', '');
  } else if (ip === '::1') {
    ip = '127.0.0.1';
  }

  return ip.trim();
}

/**
 * Factory function to create reusable Sliding Window Log rate limiters.
 * Allows distinct endpoints (e.g. /api/test vs /api/status) to have independent
 * thresholds and isolated Redis keys without duplicating rate limit logic.
 * 
 * @param {Object} options
 * @param {number} [options.maxRequests=5] Maximum allowed requests
 * @param {number} [options.windowSeconds=60] Time window duration in seconds
 * @param {string} [options.keyPrefix='ratelimit'] Redis key prefix for namespace isolation
 * @returns {Function} Express middleware function
 */
function createRateLimiter(options = {}) {
  const maxReq = parsePositiveInteger(options.maxRequests, 5, 'options.maxRequests');
  const winSec = parsePositiveInteger(options.windowSeconds, 60, 'options.windowSeconds');
  const winMs = winSec * 1000;
  const prefix = options.keyPrefix || 'ratelimit';

  return async function rateLimitMiddleware(req, res, next) {
    const clientIp = getClientIp(req);
    const key = `${prefix}:${clientIp}`;
    const now = Date.now();

    // Graceful degradation / Fail-Open strategy if Redis is temporarily unreachable
    if (!isRedisReady()) {
      console.warn(`[RateLimiter] Redis is not ready. Allowing request for IP ${clientIp} to fail open.`);
      res.setHeader('X-RateLimit-Fallback', 'true');
      return next();
    }

    // Collision-proof member generation:
    // In Redis Sorted Sets, members must be unique. Appending a random UUID guarantees
    // that simultaneous requests at the exact same millisecond do not overwrite each other.
    const uniqueMember = `${now}:${crypto.randomUUID()}`;

    try {
      // Execute atomic Lua script defined in src/config/redis.js
      const result = await redis.slidingWindowRateLimit(
        key,
        now,
        winMs,
        maxReq,
        uniqueMember
      );

      const [isAllowed, remaining, currentCount, oldestTimestamp] = result;

      // Calculate when the oldest request in the window expires to establish reset time
      const oldestTimeMs = Number(oldestTimestamp);
      const resetTimeSeconds = Math.ceil((oldestTimeMs + winMs) / 1000);
      const retryAfterSeconds = Math.max(1, Math.ceil((oldestTimeMs + winMs - now) / 1000));

      // Standard RFC Rate Limit Response Headers
      res.setHeader('X-RateLimit-Limit', maxReq);
      res.setHeader('X-RateLimit-Remaining', remaining);
      res.setHeader('X-RateLimit-Reset', resetTimeSeconds);

      // Block excess requests with HTTP 429 Too Many Requests
      if (isAllowed === 0) {
        res.setHeader('Retry-After', retryAfterSeconds);

        return res.status(429).json({
          error: 'Too Many Requests',
          message: `Rate limit exceeded. You have made too many requests within the ${winSec}-second window.`,
          limit: maxReq,
          remaining: 0,
          retryAfterSeconds,
          resetTime: resetTimeSeconds,
        });
      }

      // Attach rate limit metadata to request object for downstream handlers
      req.rateLimit = {
        clientIp,
        limit: maxReq,
        remaining,
        currentCount,
        resetTime: resetTimeSeconds,
      };

      return next();
    } catch (error) {
      console.error(`[RateLimiter] Error evaluating rate limit for key ${key}:`, error.message);

      // Fail-open strategy on unexpected execution errors to preserve availability
      res.setHeader('X-RateLimit-Fallback', 'true');
      return next();
    }
  };
}

// Default main rate limiter for protected endpoints (/api/test)
const rateLimiter = createRateLimiter({
  maxRequests: MAX_REQUESTS,
  windowSeconds: WINDOW_SECONDS,
  keyPrefix: 'ratelimit',
});

// Dedicated relaxed rate limiter for the status endpoint (/api/status) to prevent Redis DoS
const statusRateLimiter = createRateLimiter({
  maxRequests: STATUS_MAX_REQUESTS,
  windowSeconds: STATUS_WINDOW_SECONDS,
  keyPrefix: 'ratelimit:status',
});

/**
 * Inspect the current rate limit status for a given client IP without logging a new request.
 * 
 * @param {string} clientIp
 * @returns {Promise<Object>} Status object containing count, remaining, resetTime, etc.
 */
async function getRateLimitStatus(clientIp) {
  const key = `ratelimit:${clientIp}`;
  const now = Date.now();

  if (!isRedisReady()) {
    throw new Error('Redis database is currently unavailable');
  }

  // Execute read-only status inspector Lua script
  const result = await redis.slidingWindowStatus(
    key,
    now,
    WINDOW_MS,
    MAX_REQUESTS
  );

  const [currentCount, remaining, oldestTimestamp] = result;
  const oldestTimeMs = Number(oldestTimestamp);

  let resetTimeSeconds;
  let resetsInSeconds;

  if (currentCount > 0 && oldestTimeMs > 0) {
    resetTimeSeconds = Math.ceil((oldestTimeMs + WINDOW_MS) / 1000);
    resetsInSeconds = Math.max(0, Math.ceil((oldestTimeMs + WINDOW_MS - now) / 1000));
  } else {
    resetTimeSeconds = Math.ceil((now + WINDOW_MS) / 1000);
    resetsInSeconds = 0;
  }

  return {
    clientIp,
    limit: MAX_REQUESTS,
    currentUsage: currentCount,
    remaining,
    windowSeconds: WINDOW_SECONDS,
    resetTime: resetTimeSeconds,
    resetsInSeconds,
  };
}

module.exports = {
  rateLimiter,
  statusRateLimiter,
  createRateLimiter,
  getClientIp,
  getRateLimitStatus,
  parsePositiveInteger,
  MAX_REQUESTS,
  WINDOW_SECONDS,
  STATUS_MAX_REQUESTS,
  STATUS_WINDOW_SECONDS,
};
