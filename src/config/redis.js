/**
 * ==============================================================================
 * File: src/config/redis.js
 * Description: Redis client connection setup and custom Lua script definitions.
 * ==============================================================================
 * 
 * Purpose:
 *   Manages the lifecycle of the Redis connection using the 'ioredis' library.
 *   Defines and registers custom atomic Lua scripts on the Redis instance to
 *   prevent race conditions during high-concurrency rate limiting.
 */

const Redis = require('ioredis');
const dotenv = require('dotenv');

dotenv.config();

// Configuration options loaded from environment variables
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT, 10) || 6379;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;

/**
 * Custom Redis Lua Script: Sliding Window Log Rate Limiter
 * 
 * Why Lua?
 *   Redis is single-threaded in its execution of commands. By embedding the 
 *   multi-step rate limit logic inside a Lua script and executing it via EVALSHA,
 *   Redis guarantees that the script executes ATOMICALLY from start to finish.
 *   No other concurrent client request can interleave between checking the count
 *   and adding a new timestamp, completely eliminating race conditions.
 * 
 * Keys:
 *   KEYS[1] -> Rate limit key for client, e.g., 'ratelimit:<ip>'
 * 
 * Arguments:
 *   ARGV[1] -> Current timestamp in milliseconds (now)
 *   ARGV[2] -> Sliding window duration in milliseconds (windowMs)
 *   ARGV[3] -> Maximum allowed requests (maxRequests)
 *   ARGV[4] -> Unique request identifier, e.g., '<now>:<uuid>'
 * 
 * Returns:
 *   Table with 4 elements:
 *   [1] isAllowed: 1 if within limit, 0 if limit exceeded
 *   [2] remaining: Number of remaining requests allowed in this window
 *   [3] currentCount: Total valid requests within the current window
 *   [4] oldestTimestamp: Millisecond timestamp of the earliest request in the window
 */
const SLIDING_WINDOW_LUA = `
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local window = tonumber(ARGV[2])
  local limit = tonumber(ARGV[3])
  local uniqueMember = ARGV[4]

  local clearBefore = now - window

  -- Step 1: Remove all timestamps older than the sliding window threshold
  redis.call('ZREMRANGEBYSCORE', key, '-inf', clearBefore)

  -- Step 2: Count the remaining valid request timestamps in the current window
  local currentCount = redis.call('ZCARD', key)

  local isAllowed = 0
  local remaining = 0

  -- Step 3: Check if the client is within the limit
  if currentCount < limit then
    isAllowed = 1
    -- Add this request timestamp to the Sorted Set (score = timestamp, member = unique ID)
    redis.call('ZADD', key, now, uniqueMember)
    currentCount = currentCount + 1
    remaining = limit - currentCount
  else
    isAllowed = 0
    remaining = 0
  end

  -- Step 4: Refresh key TTL (time-to-live) so idle keys are automatically cleaned up
  -- TTL is set to the window duration plus a small buffer (in seconds)
  local ttlSeconds = math.ceil(window / 1000)
  redis.call('EXPIRE', key, ttlSeconds)

  -- Step 5: Query the score of the oldest request in the window to compute reset time
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local oldestTimestamp = now
  if #oldest > 0 then
    oldestTimestamp = tonumber(oldest[2])
  end

  return { isAllowed, remaining, currentCount, oldestTimestamp }
`;

/**
 * Custom Redis Lua Script: Sliding Window Status Inspector
 * 
 * Purpose:
 *   Reads the client's current usage and calculates remaining slots WITHOUT
 *   adding a new request timestamp. Used by GET /api/status.
 */
const STATUS_INSPECTOR_LUA = `
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local window = tonumber(ARGV[2])
  local limit = tonumber(ARGV[3])

  local clearBefore = now - window

  -- Purge expired entries outside the sliding window
  redis.call('ZREMRANGEBYSCORE', key, '-inf', clearBefore)

  -- Get current count of active requests
  local currentCount = redis.call('ZCARD', key)

  -- Get the oldest request timestamp in the active window
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local oldestTimestamp = now
  if #oldest > 0 then
    oldestTimestamp = tonumber(oldest[2])
  end

  local remaining = math.max(0, limit - currentCount)

  return { currentCount, remaining, oldestTimestamp }
`;

/**
 * Initialize the Redis Client
 */
const redis = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD,
  // Automatic reconnection strategy with exponential backoff
  retryStrategy(times) {
    const delay = Math.min(times * 100, 3000);
    console.warn(`[Redis] Connection lost. Attempting reconnect #${times} in ${delay}ms...`);
    return delay;
  },
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
});

// Register custom Lua commands on the ioredis instance
redis.defineCommand('slidingWindowRateLimit', {
  numberOfKeys: 1,
  lua: SLIDING_WINDOW_LUA,
});

redis.defineCommand('slidingWindowStatus', {
  numberOfKeys: 1,
  lua: STATUS_INSPECTOR_LUA,
});

// Connection state tracking
let isConnected = false;

redis.on('connect', () => {
  console.log(`[Redis] Connecting to Redis at ${REDIS_HOST}:${REDIS_PORT}...`);
});

redis.on('ready', () => {
  isConnected = true;
  console.log('[Redis] Connection established and ready to accept commands.');
});

redis.on('error', (err) => {
  isConnected = false;
  console.error('[Redis] Connection error:', err.message);
});

redis.on('close', () => {
  isConnected = false;
  console.warn('[Redis] Connection closed.');
});

redis.on('reconnecting', () => {
  isConnected = false;
  console.log('[Redis] Reconnecting...');
});

/**
 * Helper to check whether Redis is currently connected
 */
function isRedisReady() {
  return isConnected && redis.status === 'ready';
}

/**
 * Graceful health check ping
 */
async function checkRedisHealth() {
  try {
    const reply = await redis.ping();
    return reply === 'PONG';
  } catch (err) {
    return false;
  }
}

module.exports = {
  redis,
  isRedisReady,
  checkRedisHealth,
};
