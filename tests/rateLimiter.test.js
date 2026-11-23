/**
 * ==============================================================================
 * File: tests/rateLimiter.test.js
 * Description: Automated Verification Test Suite for Rate Limit Engine
 * ==============================================================================
 * 
 * Verifies:
 *   1. Reliable asynchronous readiness probe (waits for Express & Redis without arbitrary sleep)
 *   2. Root health endpoint connectivity (GET /)
 *   3. Sliding Window Log enforcement on GET /api/test (Allows 5, blocks 6th with 429)
 *   4. Rate Limit Headers (X-RateLimit-Limit, Remaining, Reset, Retry-After)
 *   5. Informational status endpoint (GET /api/status does not consume quota)
 *   6. Protection of /api/status endpoint (Relaxed rate limiter prevents DoS)
 *   7. Client IP Isolation (Different IPs maintain separate sliding windows)
 *   8. Concurrency & Race Condition Prevention (Atomic Lua script under load)
 *   9. Environment Variable & Positive Integer Validation (Handles 0, negatives, strings)
 */

// Set environment to test mode to bind to an available port without colliding with running containers
process.env.NODE_ENV = 'test';

const http = require('http');
const { app, server } = require('../src/server');
const { redis, checkRedisHealth } = require('../src/config/redis');
const { parsePositiveInteger } = require('../src/middleware/rateLimiter');

// Helper to make native HTTP requests to the running test server
function makeRequest(path, options = {}) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const reqOptions = {
      hostname: '127.0.0.1',
      port,
      path,
      method: options.method || 'GET',
      headers: options.headers || {},
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch (e) {
          parsed = data;
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: parsed,
        });
      });
    });

    req.on('error', reject);
    req.end();
  });
}

function assert(condition, message) {
  if (!condition) {
    console.error(`  ❌ FAILED: ${message}`);
    throw new Error(message);
  } else {
    console.log(`  ✅ PASSED: ${message}`);
  }
}

/**
 * Reliable Readiness Probe:
 * Eliminates flaky fixed timeouts (e.g. setTimeout(..., 500)) by actively waiting
 * for both the Express HTTP server and Redis connection to be fully initialized.
 */
async function waitForReadiness(timeoutMs = 5000) {
  const start = Date.now();

  // 1. Wait for HTTP server to start listening
  while (!server.listening) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`[ReadinessProbe] Express server failed to listen within ${timeoutMs}ms.`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  // 2. Wait for Redis connection to report 'ready'
  while (redis.status !== 'ready') {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`[ReadinessProbe] Redis connection failed to become ready within ${timeoutMs}ms. Status: ${redis.status}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  // 3. Confirm Redis health via PING
  const healthy = await checkRedisHealth(2000);
  if (!healthy) {
    throw new Error('[ReadinessProbe] Redis ping check failed during readiness verification.');
  }

  const elapsed = Date.now() - start;
  console.log(`[ReadinessProbe] Server and Redis verified ready in ${elapsed}ms.\n`);
}

async function runTestSuite() {
  console.log('======================================================');
  console.log(' Starting Rate Limiter Comprehensive Test Suite');
  console.log('======================================================\n');

  try {
    // Await deterministic readiness before running any tests
    await waitForReadiness(5000);

    // Clean up test keys in Redis for isolated testing
    const testIp = '127.0.0.1';
    await redis.del(`ratelimit:${testIp}`);
    await redis.del(`ratelimit:status:${testIp}`);
    await redis.del('ratelimit:192.168.1.50');
    await redis.del('ratelimit:192.168.1.51');

    // ------------------------------------------------------------------------
    // TEST 1: Root Health Check Endpoint
    // ------------------------------------------------------------------------
    console.log('--- TEST 1: GET / (Root Health Check) ---');
    const rootRes = await makeRequest('/');
    assert(rootRes.statusCode === 200, 'Root endpoint returns HTTP 200 OK');
    assert(rootRes.body.status === 'healthy', 'Root body reports status: healthy');
    assert(rootRes.body.redis === 'connected', 'Root body confirms Redis is connected');

    // ------------------------------------------------------------------------
    // TEST 2: Sliding Window Rate Limiting (5 allowed, 6th blocked)
    // ------------------------------------------------------------------------
    console.log('\n--- TEST 2: Sliding Window Limit (5 Requests Allowed, 6th Blocked) ---');
    for (let i = 1; i <= 5; i++) {
      const res = await makeRequest('/api/test');
      assert(res.statusCode === 200, `Request #${i} succeeded with HTTP 200`);
      assert(res.headers['x-ratelimit-limit'] === '5', `Request #${i} header X-RateLimit-Limit is 5`);
      assert(
        parseInt(res.headers['x-ratelimit-remaining'], 10) === 5 - i,
        `Request #${i} header X-RateLimit-Remaining is ${5 - i}`
      );
      assert(res.headers['x-ratelimit-reset'] !== undefined, `Request #${i} header X-RateLimit-Reset is present`);
    }

    // 6th request MUST be blocked with HTTP 429 Too Many Requests
    console.log('\n--- TEST 3: 6th Request Blocked with HTTP 429 ---');
    const blockedRes = await makeRequest('/api/test');
    assert(blockedRes.statusCode === 429, '6th request rejected with HTTP 429 Too Many Requests');
    assert(blockedRes.headers['x-ratelimit-remaining'] === '0', 'Blocked response header X-RateLimit-Remaining is 0');
    assert(blockedRes.headers['retry-after'] !== undefined, 'Blocked response includes Retry-After header');
    assert(parseInt(blockedRes.headers['retry-after'], 10) > 0, 'Retry-After seconds is greater than 0');
    assert(blockedRes.body.error === 'Too Many Requests', 'JSON error message is "Too Many Requests"');

    // ------------------------------------------------------------------------
    // TEST 4: Status Inspector (GET /api/status does not consume /api/test quota)
    // ------------------------------------------------------------------------
    console.log('\n--- TEST 4: GET /api/status (Inspect Usage Without Consuming Test Quota) ---');
    const statusRes = await makeRequest('/api/status');
    assert(statusRes.statusCode === 200, 'Status endpoint returns HTTP 200');
    assert(statusRes.body.data.currentUsage === 5, 'Status correctly reports test endpoint usage: 5');
    assert(statusRes.body.data.remaining === 0, 'Status correctly reports test endpoint remaining: 0');
    assert(statusRes.headers['x-ratelimit-limit'] === '30', 'Status endpoint response header reflects its own limit (30)');

    // ------------------------------------------------------------------------
    // TEST 5: Status Endpoint Rate Limiting (Protected against DoS)
    // ------------------------------------------------------------------------
    console.log('\n--- TEST 5: Protection of /api/status Endpoint ---');
    // Pre-seed status limit key to simulate 30 requests already made
    const statusKey = `ratelimit:status:${testIp}`;
    const nowTs = Date.now();
    for (let k = 0; k < 30; k++) {
      await redis.zadd(statusKey, nowTs, `${nowTs}:${k}:status-test`);
    }
    await redis.expire(statusKey, 60);

    const floodedStatusRes = await makeRequest('/api/status');
    assert(floodedStatusRes.statusCode === 429, '31st request to /api/status is BLOCKED with HTTP 429');
    assert(floodedStatusRes.headers['x-ratelimit-remaining'] === '0', 'Status response header Remaining is 0');
    await redis.del(statusKey); // Clean up status test key

    // ------------------------------------------------------------------------
    // TEST 6: Separate Client IP Histories
    // ------------------------------------------------------------------------
    console.log('\n--- TEST 6: Client IP Isolation ---');
    const anotherIp = '10.0.0.99';
    await redis.del(`ratelimit:${anotherIp}`);
    const isolatedStatus = await redis.slidingWindowStatus(
      `ratelimit:${anotherIp}`,
      Date.now(),
      60000,
      5
    );
    assert(isolatedStatus[0] === 0, `IP ${anotherIp} has 0 usage while ${testIp} is exhausted`);
    assert(isolatedStatus[1] === 5, `IP ${anotherIp} has all 5 requests remaining`);

    // ------------------------------------------------------------------------
    // TEST 7: Atomic Concurrency & Race Condition Prevention
    // ------------------------------------------------------------------------
    console.log('\n--- TEST 7: High Concurrency Test (Simultaneous Atomic Execution) ---');
    const concurrentIp = '192.168.1.51';
    await redis.del(`ratelimit:${concurrentIp}`);

    const now = Date.now();
    const concurrentPromises = [];
    for (let i = 0; i < 10; i++) {
      const uniqueId = `${now}:${i}:test-uuid`;
      concurrentPromises.push(
        redis.slidingWindowRateLimit(
          `ratelimit:${concurrentIp}`,
          now,
          60000,
          5,
          uniqueId
        )
      );
    }

    const concurrentResults = await Promise.all(concurrentPromises);
    const allowedCount = concurrentResults.filter((res) => res[0] === 1).length;
    const blockedCount = concurrentResults.filter((res) => res[0] === 0).length;

    assert(
      allowedCount === 5,
      `Exactly 5 concurrent requests were ALLOWED (Actual: ${allowedCount})`
    );
    assert(
      blockedCount === 5,
      `Exactly 5 concurrent requests were BLOCKED (Actual: ${blockedCount})`
    );
    console.log('  -> Atomic Lua script prevented race conditions flawlessly!');

    // ------------------------------------------------------------------------
    // TEST 8: Environment Variable & Positive Integer Validation
    // ------------------------------------------------------------------------
    console.log('\n--- TEST 8: Configuration Parsing & Positive Integer Validation ---');
    assert(parsePositiveInteger('10', 5, 'TEST_VAR') === 10, 'Valid positive integer string "10" parses to 10');
    assert(parsePositiveInteger(undefined, 5, 'TEST_VAR') === 5, 'Undefined falls back to default 5');
    assert(parsePositiveInteger('', 5, 'TEST_VAR') === 5, 'Empty string falls back to default 5');
    assert(parsePositiveInteger('0', 5, 'TEST_VAR') === 5, 'Zero correctly falls back to default 5 (resolves falsy bug)');
    assert(parsePositiveInteger('-10', 5, 'TEST_VAR') === 5, 'Negative integer falls back to default 5');
    assert(parsePositiveInteger('invalid', 5, 'TEST_VAR') === 5, 'Non-numeric string falls back to default 5');
    assert(parsePositiveInteger('3.14', 5, 'TEST_VAR') === 5, 'Float string falls back to default 5');

    console.log('\n======================================================');
    console.log('  ALL TESTS PASSED SUCCESSFULLY! (8/8)');
    console.log('======================================================\n');
  } catch (error) {
    console.error('\nTest Suite Failed:', error);
    process.exitCode = 1;
  } finally {
    // Clean up connections
    await redis.quit();
    server.close();
  }
}

// Start test suite immediately; internal readiness probe manages timing
runTestSuite();
