/**
 * ==============================================================================
 * File: tests/rateLimiter.test.js
 * Description: Automated Verification Test Suite for Rate Limit Engine
 * ==============================================================================
 * 
 * Verifies:
 *   1. Root health endpoint connectivity (GET /)
 *   2. Sliding Window Log enforcement on GET /api/test (Allows 5, blocks 6th with 429)
 *   3. Rate Limit Headers (X-RateLimit-Limit, Remaining, Reset, Retry-After)
 *   4. Client IP Isolation (Different IPs maintain separate sliding windows)
 *   5. Informational status endpoint (GET /api/status does not consume quota)
 *   6. Concurrency & Race Condition Prevention (Atomic Lua script under load)
 */

const http = require('http');
const { app, server } = require('../src/server');
const { redis } = require('../src/config/redis');

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

async function runTestSuite() {
  console.log('\n======================================================');
  console.log(' Starting Rate Limiter Comprehensive Test Suite');
  console.log('======================================================\n');

  try {
    // Ensure Redis is clean for test client IPs
    const testIp = '127.0.0.1';
    await redis.del(`ratelimit:${testIp}`);
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
    // TEST 4: Status Inspector (GET /api/status does not consume quota)
    // ------------------------------------------------------------------------
    console.log('\n--- TEST 4: GET /api/status (Inspect Usage Without Consuming Quota) ---');
    const statusRes = await makeRequest('/api/status');
    assert(statusRes.statusCode === 200, 'Status endpoint returns HTTP 200');
    assert(statusRes.body.data.currentUsage === 5, 'Status correctly reports currentUsage: 5');
    assert(statusRes.body.data.remaining === 0, 'Status correctly reports remaining: 0');

    // ------------------------------------------------------------------------
    // TEST 5: Separate Client IP Histories
    // ------------------------------------------------------------------------
    console.log('\n--- TEST 5: Client IP Isolation ---');
    // We test a distinct IP directly against Redis and verify separate tracking
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
    // TEST 6: Atomic Concurrency & Race Condition Prevention
    // ------------------------------------------------------------------------
    console.log('\n--- TEST 6: High Concurrency Test (Simultaneous Atomic Execution) ---');
    const concurrentIp = '192.168.1.51';
    await redis.del(`ratelimit:${concurrentIp}`);

    // Fire 10 simultaneous atomic requests for the same IP
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

    console.log('\n======================================================');
    console.log('  ALL TESTS PASSED SUCCESSFULLY! (6/6)');
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

// Give server and Redis a moment to establish connection before running
setTimeout(runTestSuite, 500);
