/**
 * ==============================================================================
 * File: src/server.js
 * Description: Express server entry point, middleware configuration, and routing
 * ==============================================================================
 * 
 * Purpose:
 *   Bootstraps the Express application, configures security and proxy settings,
 *   mounts API routes, handles 404 and global errors, and coordinates graceful
 *   shutdown with Redis.
 */

const express = require('express');
const dotenv = require('dotenv');
const apiRoutes = require('./routes/api');
const { redis, checkRedisHealth } = require('./config/redis');

// Load environment variables from .env
dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

/**
 * Trusted Proxy Configuration:
 * Express must know whether it is behind a reverse proxy (e.g. Nginx, Docker, Cloudflare).
 * 
 * Security Warning:
 * Never blindly trust headers from untrusted clients. If TRUST_PROXY is false,
 * Express ignores 'X-Forwarded-For' to prevent IP spoofing attacks.
 */
const trustProxyConfig = process.env.TRUST_PROXY;
if (trustProxyConfig === 'true') {
  app.set('trust proxy', true);
} else if (trustProxyConfig && trustProxyConfig !== 'false') {
  // Can be a number of hops (e.g., 1) or specific subnet (e.g., 'loopback')
  const hops = parseInt(trustProxyConfig, 10);
  app.set('trust proxy', isNaN(hops) ? trustProxyConfig : hops);
} else {
  app.set('trust proxy', false);
}

// Built-in body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Lightweight request logging middleware for academic demonstration
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const clientIp = req.ip || req.socket?.remoteAddress;
    console.log(`[HTTP] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${duration}ms) [IP: ${clientIp}]`);
  });
  next();
});

/**
 * Root Route: Basic API Health and Metadata
 * GET /
 */
app.get('/', async (req, res) => {
  const isRedisHealthy = await checkRedisHealth();

  res.status(200).json({
    status: isRedisHealthy ? 'healthy' : 'degraded',
    message: 'Rate Limit Engine API is running',
    environment: NODE_ENV,
    redis: isRedisHealthy ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
    endpoints: {
      test: {
        method: 'GET',
        path: '/api/test',
        description: 'Protected endpoint subjected to Sliding Window Log rate limiter (5 req/min)',
      },
      status: {
        method: 'GET',
        path: '/api/status',
        description: 'Check current rate limit usage and remaining quota for calling IP',
      },
    },
  });
});

// Mount modular API routes
app.use('/api', apiRoutes);

/**
 * 404 Handler for undefined routes
 */
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.originalUrl}`,
  });
});

/**
 * Global Error Handling Middleware
 */
app.use((err, req, res, next) => {
  console.error('[ServerError] Unhandled error:', err);
  res.status(err.status || 500).json({
    error: 'Internal Server Error',
    message: NODE_ENV === 'production' ? 'An unexpected error occurred.' : err.message,
  });
});

/**
 * Start the HTTP Server
 */
const server = app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(` Rate Limit Engine Server listening on port ${PORT}`);
  console.log(` Environment: ${NODE_ENV}`);
  console.log(` Health check: http://localhost:${PORT}/`);
  console.log(` Test endpoint: http://localhost:${PORT}/api/test`);
  console.log(` Status endpoint: http://localhost:${PORT}/api/status`);
  console.log(`====================================================`);
});

/**
 * Graceful Process Termination
 * Ensures in-flight HTTP connections complete, idle connections are closed,
 * and Redis disconnects cleanly without hanging.
 */
function gracefulShutdown(signal) {
  console.log(`\n[Server] Received ${signal}. Initiating graceful shutdown...`);

  // Stop accepting new connections
  server.close(async () => {
    console.log('[Server] HTTP server closed.');

    try {
      await redis.quit();
      console.log('[Redis] Redis connection cleanly closed.');
    } catch (err) {
      console.error('[Redis] Error during Redis disconnect:', err.message);
    }

    process.exit(0);
  });

  // Close idle keep-alive connections immediately (Node.js 18.2+)
  if (typeof server.closeIdleConnections === 'function') {
    server.closeIdleConnections();
  }

  // Force exit if graceful shutdown takes longer than 5 seconds
  setTimeout(() => {
    console.error('[Server] Forced shutdown due to timeout.');
    process.exit(1);
  }, 5000).unref(); // unref() prevents the timeout from keeping the event loop alive
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Process-level error handling to prevent continuing in an unknown corrupted state
process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught Exception thrown:', err);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process] Unhandled Promise Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('unhandledRejection');
});

module.exports = { app, server };
