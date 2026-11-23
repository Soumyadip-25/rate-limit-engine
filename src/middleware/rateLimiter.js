/**
 * ==============================================================================
 * File: src/middleware/rateLimiter.js
 * Description: Sliding Window Log Rate Limiting Middleware using Redis Sorted Sets
 * ==============================================================================
 * 
 * Algorithm: Sliding Window Log
 *   Unlike Fixed Window algorithms (which reset counters on arbitrary clock boundaries
 *   and allow 2x traffic bursts at boundary edges), the Sliding Window Log maintains
 *   a chronological log of timestamps for each request.
 * 
 *   When a new request arrives:
 *     1. All timestamps older than (currentTime - windowDuration) are removed.
 *     2. The number of remaining timestamps is counted.
 *     3. If count < limit: The request timestamp is recorded, and the request proceeds.
 *     4. If count >= limit: The request is rejected with HTTP 429 (Too Many Requests).
 * 
 * Redis Data Structure: Sorted Set (ZSET)
 *   - Key: 'ratelimit:<client_ip>'
 *   - Score: Floating-point UNIX timestamp in milliseconds (allows range queries).
 *   - Member: Unique identifier '<timestamp>:<uuid>' (guarantees uniqueness).
 */

const crypto = require('crypto');
const { redis, isRedisReady } = require('../config/redis');

// Rate limiter configuration from environment variables with sensible defaults
const MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 5;
const WINDOW_SECONDS = parseInt(process.env.RATE_LIMIT_WINDOW_SECONDS, 10) || 60;
const WINDOW_MS = WINDOW_SECONDS * 1000;

/**
 * Safely extracts the client IP address.
 * 
 * Note on Trusted Proxies:
 *   Express populates `req.ip` based on the 'trust proxy' setting configured in server.js.
 *   If trust proxy is enabled, Express extracts the client IP from X-Forwarded-For using
 *   configured trust hops or subnets.
 *   If trust proxy is disabled (default), req.ip uses the direct TCP socket address
 *   (req.socket.remoteAddress), preventing clients from spoofing their IP via headers.
 * 
 * @param {import('express').Request} req
 * @returns {string} Sanitized IP address
 */
function getClientIp(req) {
  let ip = req.ip || req.socket?.remoteAddress || '127.0.0.1';

  // Normalize IPv4-mapped IPv6 addresses (e.g., '::ffff:127.0.0.1' -> '127.0.0.1')
  if (ip.startsWith('::ffff:')) {
    ip = ip.replace('::ffff:', '');
  } else if (ip === '::1') {
    ip = '127.0.0.1';
  }

  return ip;
}

/**
 * Sliding Window Log Rate Limiter Middleware
 * 
 * Atomically executes the sliding window log evaluation in Redis via a Lua script.
 * Injects standard HTTP rate limit headers:
 *   - X-RateLimit-Limit: Maximum allowed requests within the window
 *   - X-RateLimit-Remaining: Number of remaining requests allowed
 *   - X-RateLimit-Reset: Epoch timestamp (in seconds) when the window/slot resets
 *   - Retry-After: Seconds to wait before retrying (sent on HTTP 429)
 */
async function rateLimiter(req, res, next) {
  const clientIp = getClientIp(req);
  const key = `ratelimit:${clientIp}`;
  const now = Date.now();

  // Graceful degradation / Fail-Open strategy if Redis is temporarily unreachable
  if (!isRedisReady()) {
    console.warn(`[RateLimiter] Redis is not ready. Allowing request for IP ${clientIp} to fail open.`);
    res.setHeader('X-RateLimit-Fallback', 'true');
    return next();
  }

  // Prevent duplicate member collisions in Redis Sorted Sets:
  // In Redis Sorted Sets, members MUST be unique. If two requests arrive in the exact
  // same millisecond and we only used the timestamp as member, ZADD would overwrite
  // the existing member without incrementing the set size!
  // Appending a random UUID guarantees every request is tracked as a distinct entry.
  const uniqueMember = `${now}:${crypto.randomUUID()}`;

  try {
    // Execute atomic Lua script defined in src/config/redis.js
    // Parameters: key, now, windowMs, maxRequests, uniqueMember
    const result = await redis.slidingWindowRateLimit(
      key,
      now,
      WINDOW_MS,
      MAX_REQUESTS,
      uniqueMember
    );

    const [isAllowed, remaining, currentCount, oldestTimestamp] = result;

    // Calculate when the oldest request in the current window will expire
    // Reset time is the epoch timestamp (in seconds) when a slot will become available
    const oldestTimeMs = Number(oldestTimestamp);
    const resetTimeSeconds = Math.ceil((oldestTimeMs + WINDOW_MS) / 1000);
    const retryAfterSeconds = Math.max(1, Math.ceil((oldestTimeMs + WINDOW_MS - now) / 1000));

    // Standard RFC Rate Limit Response Headers
    res.setHeader('X-RateLimit-Limit', MAX_REQUESTS);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', resetTimeSeconds);

    // If request exceeded the maximum limit, block with HTTP 429
    if (isAllowed === 0) {
      res.setHeader('Retry-After', retryAfterSeconds);

      return res.status(429).json({
        error: 'Too Many Requests',
        message: `Rate limit exceeded. You have made too many requests within the ${WINDOW_SECONDS}-second window.`,
        limit: MAX_REQUESTS,
        remaining: 0,
        retryAfterSeconds,
        resetTime: resetTimeSeconds,
      });
    }

    // Attach rate limit information to the request object for downstream routes if needed
    req.rateLimit = {
      clientIp,
      limit: MAX_REQUESTS,
      remaining,
      currentCount,
      resetTime: resetTimeSeconds,
    };

    return next();
  } catch (error) {
    console.error(`[RateLimiter] Redis error while processing rate limit for IP ${clientIp}:`, error.message);

    // Fail-open strategy on unexpected execution errors:
    // Log the error and allow the request to proceed rather than blocking users
    // due to an internal caching layer failure.
    res.setHeader('X-RateLimit-Fallback', 'true');
    return next();
  }
}

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
  getClientIp,
  getRateLimitStatus,
  MAX_REQUESTS,
  WINDOW_SECONDS,
};
