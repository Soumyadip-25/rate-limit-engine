# Rate Limit Engine

A production-grade, distributed **Sliding Window Log Rate Limiter** built with **Node.js**, **Express.js**, and **Redis Sorted Sets (ZSET)**. Containerized with **Docker** and **Docker Compose**.

---

## 1. Project Introduction

In modern web applications and microservices, rate limiting is a fundamental defense mechanism. It protects backend services against:
- Denial of Service (DoS) and Distributed Denial of Service (DDoS) attacks.
- Brute-force credential stuffing and web scraping bots.
- Cascading API failures caused by accidental client retry loops.

The **Rate Limit Engine** regulates the number of incoming HTTP requests a client can make within a continuous rolling time window (by default, **5 requests per 60-second window** per client IP address). If a client exceeds this threshold, the system immediately blocks subsequent requests with **HTTP 429 (Too Many Requests)** and returns standard rate-limiting headers indicating when the client may retry.

---

## 2. Features

- **Sliding Window Log Algorithm**: Eliminates the "boundary burst" vulnerability found in naive fixed-window limiters by maintaining an exact historical log of request timestamps.
- **Atomic Concurrency with Redis Lua**: All evaluation steps (purging expired timestamps, counting active requests, adding new logs, and setting TTL) execute in a single, uninterrupted atomic Lua script inside Redis, completely preventing race conditions.
- **Redis Sorted Sets (ZSET)**: Employs Redis Sorted Sets where scores represent millisecond timestamps, enabling $O(\log N + M)$ range deletions and $O(1)$ cardinality counts.
- **Collision-Proof Member Tracking**: Appends cryptographically random UUIDs to millisecond timestamps to ensure concurrent requests in the exact same millisecond are never overwritten.
- **Safe Proxy Handling**: Configurable `TRUST_PROXY` support to accurately resolve client IPs while preventing header spoofing via untrusted `X-Forwarded-For` injection.
- **Graceful Degradation (Fail-Open)**: If the Redis database experiences transient network failure, the middleware logs warnings, sets `X-RateLimit-Fallback: true`, and allows traffic to proceed rather than taking down the API.
- **Standard RFC Headers**: Includes `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After`.
- **Informational Status Endpoint**: Allows clients and frontends to inspect remaining quota without consuming a request slot.
- **Full Docker & Docker Compose Support**: Production-ready containerization with health checks and persistent storage.

---

## 3. Technology Stack

| Component | Technology | Description |
| :--- | :--- | :--- |
| **Runtime** | Node.js (v20+) | High-performance asynchronous JavaScript engine |
| **Framework** | Express.js (v4) | Minimalist web application framework |
| **In-Memory Store** | Redis (v7 Alpine) | Ultra-fast in-memory database used for Sorted Sets |
| **Redis Client** | ioredis | Robust Node.js Redis client supporting Lua scripting and cluster modes |
| **Configuration** | dotenv | Twelve-factor configuration management via `.env` |
| **Containers** | Docker & Docker Compose | Containerization with service dependencies and health checks |
| **Dev Tooling** | Nodemon | Hot-reloading server utility for rapid local development |
| **Testing** | Native Node Test Suite & Postman | Comprehensive automated verification and API collection |

---

## 4. Deep Dive: Redis Sorted Sets & Sliding Window Log

### Why Redis Sorted Sets (ZSET)?

A Redis Sorted Set is a collection of unique string members where each member is associated with a floating-point numerical **score**. The members are maintained in sorted order based on their scores.

In the Sliding Window Log algorithm:
- **Redis Key**: `ratelimit:<client_ip>` (e.g., `ratelimit:192.168.1.1`)
- **Score**: Millisecond timestamp of when the request arrived (`Date.now()`).
- **Member**: Unique string combining the timestamp and a random UUID: `${timestamp}:${uuid}`.

#### Why not use a simple Redis String counter (`INCR`)?
A simple counter represents a **Fixed Window Counter**. In a fixed window (e.g., 12:00 to 12:01):
- A user can send 5 requests at 12:00:59.
- The window resets at 12:01:00.
- The user can immediately send another 5 requests at 12:01:01.
- **Result**: The client sent 10 requests within a 2-second window! This 2x burst vulnerability can overwhelm fragile downstream services.

#### How Sorted Sets solve this:
The **Sliding Window Log** tracks the exact time of every individual request. When a new request arrives at time $T_{now}$ with window duration $W$ (60,000 ms):
1. **Purge Expired Requests**: Remove all records whose score is less than $(T_{now} - W)$ using `ZREMRANGEBYSCORE key -inf (now - window)`.
2. **Count Active Requests**: Get the exact number of requests that occurred in the last 60 seconds using `ZCARD key`.
3. **Evaluate Limit**:
   - If `count < limit`: Add the new request using `ZADD key now <unique_member>`, refresh TTL using `EXPIRE key 60`, and allow the request through.
   - If `count >= limit`: Reject the request with HTTP 429.
4. **Determine Slot Reset**: The earliest request in the set (`ZRANGE key 0 0 WITHSCORES`) tells us exactly when the next available request slot will open.

### The Critical Need for Lua Scripting

If we executed `ZREMRANGEBYSCORE`, `ZCARD`, and `ZADD` as separate network round-trips from Node.js, a race condition would occur under concurrent traffic:

```
Thread 1 (Req A): ZCARD -> returns 4 (limit is 5)
Thread 2 (Req B): ZCARD -> returns 4 (limit is 5)
Thread 1 (Req A): ZADD -> added! (total = 5)
Thread 2 (Req B): ZADD -> added! (total = 6 -> LIMIT BREACHED!)
```

By packaging this logic inside a **Redis Lua Script**, Redis executes all commands **atomically** in a single thread without interruption. No other request can interleave, ensuring 100% thread safety and accuracy.

---

## 5. Project Architecture

```
rate-limit-engine/
├── src/
│   ├── config/
│   │   └── redis.js           # Redis client initialization, Lua scripts, and health tracking
│   ├── middleware/
│   │   └── rateLimiter.js     # Sliding window middleware, IP extraction, and header handling
│   ├── routes/
│   │   └── api.js             # Protected (/test) and monitoring (/status) routes
│   └── server.js              # Express app bootstrap, proxy config, error handlers, shutdown
├── tests/
│   └── rateLimiter.test.js    # Comprehensive automated verification test suite
├── test_rate_limit.sh         # Automated 10-request Bash rate limit test script
├── .dockerignore              # Docker build exclusion rules
├── .env.example               # Template environment configuration
├── .env                       # Local environment variables
├── .gitignore                 # Git ignore rules
├── Dockerfile                 # Multi-stage production container build
├── docker-compose.yml         # Compose definition for Redis and API app
├── package.json               # Dependencies and npm scripts
├── postman_collection.json    # Ready-to-import Postman test collection
└── README.md                  # System documentation
```

### Module Communication Flow

```
[ Client Request ]
       │
       ▼
[ Express Server (server.js) ] ──── Configures Trust Proxy & Security
       │
       ▼
[ Router (routes/api.js) ]
       │
       ▼
[ Rate Limiter Middleware (rateLimiter.js) ]
       │
       ├── Reads Client IP safely (handles proxies without spoofing)
       ├── Generates collision-proof member (${now}:${uuid})
       │
       ▼
[ Redis Connection & Lua Engine (config/redis.js) ]
       │
       ├── Calls atomic slidingWindowRateLimit Lua script
       └── Redis evaluates ZREMRANGEBYSCORE, ZCARD, ZADD, EXPIRE
       │
       ├── [If within limit (count < 5)]
       │     └─► Injects X-RateLimit-* headers -> Calls next() -> 200 OK
       │
       └── [If limit exceeded (count >= 5)]
             └─► Injects Retry-After & X-RateLimit-* -> Halts request -> 429 Too Many Requests
```

---

## 6. Installation & Local Setup

### Prerequisites

Ensure you have the following installed on your machine:
- **Node.js**: v18 or later
- **npm**: v9 or later
- **Docker & Docker Compose** (for running Redis or the complete stack)

### Step 1: Clone the repository

```bash
git clone <repository-url>
cd rate-limit-engine
```

### Step 2: Configure Environment Variables

Copy `.env.example` to create `.env`:

```bash
cp .env.example .env
```

Default `.env` settings:
```ini
# Server Configuration
PORT=3000
NODE_ENV=development

# Redis Configuration (Local)
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=

# Rate Limiter Settings (Sliding Window Log)
RATE_LIMIT_MAX_REQUESTS=5
RATE_LIMIT_WINDOW_SECONDS=60

# Proxy Configuration
TRUST_PROXY=false
```

### Step 3: Install Node.js Dependencies

```bash
npm install
```

### Step 4: Start Redis via Docker

To run only the Redis database container locally on port `6379`:

```bash
docker-compose up -d redis
```

Verify Redis is running and healthy:
```bash
docker ps
```

### Step 5: Start the Backend Application

Run in development mode with hot-reloading:
```bash
npm run dev
```

Or run in standard production mode:
```bash
npm start
```

---

## 7. Full Docker Compose Deployment

You can run both the Node.js application and the Redis database simultaneously in Docker:

```bash
# Build and run all containers in the background
docker-compose up -d --build
```

To view real-time container logs:
```bash
docker-compose logs -f app
```

To stop all containers:
```bash
docker-compose down
```

---

## 8. API Endpoint Documentation

### 1. Root Health Check
- **Route**: `GET /`
- **Description**: Returns server status, current timestamp, and Redis health.
- **Example Response (200 OK)**:
```json
{
  "status": "healthy",
  "message": "Rate Limit Engine API is running",
  "environment": "development",
  "redis": "connected",
  "timestamp": "2026-11-24T00:30:00.000Z",
  "endpoints": {
    "test": {
      "method": "GET",
      "path": "/api/test",
      "description": "Protected endpoint subjected to Sliding Window Log rate limiter (5 req/min)"
    },
    "status": {
      "method": "GET",
      "path": "/api/status",
      "description": "Check current rate limit usage and remaining quota for calling IP"
    }
  }
}
```

---

### 2. Protected Test Endpoint
- **Route**: `GET /api/test`
- **Protection**: Subject to the Sliding Window Log rate limiter (5 requests / 60 seconds).
- **Allowed Response (HTTP 200 OK)**:
```json
{
  "success": true,
  "message": "Request successful! You are within your rate limit.",
  "data": {
    "clientIp": "127.0.0.1",
    "limit": 5,
    "remaining": 4,
    "currentUsage": 1,
    "resetTime": 1732400060,
    "timestamp": "2026-11-24T00:30:05.123Z"
  }
}
```
**Response Headers**:
```http
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 4
X-RateLimit-Reset: 1732400060
```

- **Blocked Response (HTTP 429 Too Many Requests)**:
```json
{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded. You have made too many requests within the 60-second window.",
  "limit": 5,
  "remaining": 0,
  "retryAfterSeconds": 48,
  "resetTime": 1732400060
}
```
**Response Headers**:
```http
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1732400060
Retry-After: 48
```

---

### 3. Rate Limit Status Inspector
- **Route**: `GET /api/status`
- **Protection**: Protected by `statusRateLimiter` (default: 30 requests / 60 seconds) to prevent Redis DoS.
- **Description**: Inspects the calling client's current usage, remaining requests, and reset timer for `/api/test` **without consuming a test slot**.
- **Example Response (HTTP 200 OK)**:
```json
{
  "success": true,
  "data": {
    "clientIp": "127.0.0.1",
    "limit": 5,
    "currentUsage": 3,
    "remaining": 2,
    "windowSeconds": 60,
    "resetTime": 1732400060,
    "resetsInSeconds": 42
  }
}
```

---

## 9. Testing Guide

### Option A: Run the Automated Verification Suite

The repository includes a comprehensive automated test script that tests all requirements (health, limit enforcement, 429 response, header verification, IP isolation, and race-condition prevention under high concurrency):

```bash
npm test
```

Expected Output:
```
======================================================
 Starting Rate Limiter Comprehensive Test Suite
======================================================

--- TEST 1: GET / (Root Health Check) ---
  ✅ PASSED: Root endpoint returns HTTP 200 OK
  ✅ PASSED: Root body reports status: healthy
  ✅ PASSED: Root body confirms Redis is connected

--- TEST 2: Sliding Window Limit (5 Requests Allowed, 6th Blocked) ---
  ✅ PASSED: Request #1 succeeded with HTTP 200 (Remaining: 4)
  ✅ PASSED: Request #2 succeeded with HTTP 200 (Remaining: 3)
  ✅ PASSED: Request #3 succeeded with HTTP 200 (Remaining: 2)
  ✅ PASSED: Request #4 succeeded with HTTP 200 (Remaining: 1)
  ✅ PASSED: Request #5 succeeded with HTTP 200 (Remaining: 0)

--- TEST 3: 6th Request Blocked with HTTP 429 ---
  ✅ PASSED: 6th request rejected with HTTP 429 Too Many Requests
  ✅ PASSED: Blocked response header X-RateLimit-Remaining is 0
  ✅ PASSED: Blocked response includes Retry-After header
  ✅ PASSED: Retry-After seconds is greater than 0
  ✅ PASSED: JSON error message is "Too Many Requests"

--- TEST 4: GET /api/status (Inspect Usage Without Consuming Test Quota) ---
  ✅ PASSED: Status endpoint returns HTTP 200
  ✅ PASSED: Status correctly reports test endpoint usage: 5
  ✅ PASSED: Status correctly reports test endpoint remaining: 0
  ✅ PASSED: Status endpoint response header reflects its own limit (30)

--- TEST 5: Protection of /api/status Endpoint ---
  ✅ PASSED: 31st request to /api/status is BLOCKED with HTTP 429
  ✅ PASSED: Status response header Remaining is 0

--- TEST 6: Client IP Isolation ---
  ✅ PASSED: IP 10.0.0.99 has 0 usage while 127.0.0.1 is exhausted
  ✅ PASSED: IP 10.0.0.99 has all 5 requests remaining

--- TEST 7: High Concurrency Test (Simultaneous Atomic Execution) ---
  ✅ PASSED: Exactly 5 concurrent requests were ALLOWED (Actual: 5)
  ✅ PASSED: Exactly 5 concurrent requests were BLOCKED (Actual: 5)
  -> Atomic Lua script prevented race conditions flawlessly!

--- TEST 8: Configuration Parsing & Positive Integer Validation ---
  ✅ PASSED: Valid positive integer string "10" parses to 10
  ✅ PASSED: Undefined falls back to default 5
  ✅ PASSED: Empty string falls back to default 5
  ✅ PASSED: Zero correctly falls back to default 5 (resolves falsy bug)
  ✅ PASSED: Negative integer falls back to default 5
  ✅ PASSED: Non-numeric string falls back to default 5
  ✅ PASSED: Float string falls back to default 5

======================================================
  ALL TESTS PASSED SUCCESSFULLY! (8/8)
======================================================
```

---

### Option B: Automated Bash Testing Script (test_rate_limit.sh)

The repository provides an automated Bash script `test_rate_limit.sh` designed to test the rate-limiting functionality from Linux, macOS, WSL, or Git Bash on Windows.

#### What it does:
- Sends **10 consecutive HTTP GET requests** to `http://localhost:3000/api/test`.
- Captures and separates the HTTP status code and response body for every request.
- Displays `✓ REQUEST ALLOWED (HTTP 200 OK)` for allowed requests.
- Displays `✗ REQUEST BLOCKED (HTTP 429 Too Many Requests)` for rate-limited requests.
- Displays `! UNEXPECTED RESPONSE` for connection failures or unexpected status codes.
- Outputs an execution summary at the end.

#### How to execute:

> **Important**: The backend server must be running before executing this test (`npm start`, `npm run dev`, or `docker-compose up`).

```bash
bash test_rate_limit.sh
```

#### Expected Result:
When the rate limiter is configured with the default limit of **5 requests per 60 seconds**:
- **Requests 1 through 5**: Return `HTTP 200 OK` (`REQUEST ALLOWED`), with `X-RateLimit-Remaining` counting down from 4 to 0.
- **Requests 6 through 10**: Return `HTTP 429 Too Many Requests` (`REQUEST BLOCKED`) with error payload and `Retry-After` seconds.
- **Summary**: Reports `Allowed (HTTP 200): 5` and `Blocked (HTTP 429): 5`.

---

### Option C: Testing with Postman

1. Open **Postman**.
2. Click **Import** (top left).
3. Select the file `postman_collection.json` located in the root of this project.
4. The collection **Rate Limit Engine API** will appear with three requests:
   - `1. Health Check (GET /)`
   - `2. Protected Rate-Limited Endpoint (GET /api/test)`
   - `3. Inspect Rate Limit Status (GET /api/status)`
5. Send request `GET /api/test` rapidly 6 times:
   - Calls 1 to 5 will return status **200 OK**. Inspect the response headers tab to watch `X-RateLimit-Remaining` decrease from `4` to `0`.
   - Call 6 will immediately return status **429 Too Many Requests**, with header `Retry-After: <seconds>` and a helpful JSON error payload.
6. Send `GET /api/status` to inspect current metrics without consuming additional tokens.

---

### Option D: Manual cURL / PowerShell Testing

In bash or terminal:
```bash
# Rapidly fire 6 requests to see the rate limiter trigger
for i in {1..6}; do
  echo "--- Request #$i ---"
  curl -i http://localhost:3000/api/test
  echo ""
done
```

---

## 10. Academic Evaluation & Architecture Summary

| Question for Evaluator | Technical Answer |
| :--- | :--- |
| **Why not use Redis Strings (`INCR`)?** | Fixed windows permit double the quota at window boundaries (e.g., 5 requests at second 59 and 5 requests at second 61). Sorted Sets enable continuous rolling logs. |
| **How is high concurrency handled?** | Redis Lua scripts execute atomically on the single-threaded Redis engine, eliminating check-then-set race conditions. |
| **What happens if two requests arrive at the same millisecond?** | Redis Sorted Sets require unique members. We append a UUID (`${timestamp}:${uuid}`) so each request gets a distinct entry rather than overwriting the previous one. |
| **How are IP addresses protected against spoofing?** | Express's `trust proxy` setting is carefully managed. Arbitrary `X-Forwarded-For` headers are discarded unless an authorized reverse proxy hop is explicitly configured. |
| **What happens if Redis goes offline?** | The middleware employs a graceful fail-open strategy: logs a warning, tags the response with `X-RateLimit-Fallback: true`, and lets traffic through so core services remain available. |
