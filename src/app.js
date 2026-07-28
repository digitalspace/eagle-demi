'use strict';

const nodeCrypto = require('crypto');
if (!globalThis.crypto || !globalThis.crypto.getRandomValues) {
  try {
    globalThis.crypto = nodeCrypto.webcrypto || nodeCrypto;
  } catch (e) {
    /* ignore crypto fallback error */
  }
}

const path = require('path');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const express = require('express');
const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');
const { initCosmosClient } = require('./db/cosmos');
const { logger } = require('./utils/logger');

const apiRoutes = require('./routes/api');

// Initialize Express
const app = express();

// Request ID Tracing, Rate Limiting & HTTP Request Metrics Middlewares (Applied first)
const requestIdMiddleware = require('./middleware/request-id');
const httpLoggerMiddleware = require('./middleware/http-logger');
const rateLimiterMiddleware = require('./middleware/rate-limiter');

app.use(requestIdMiddleware);
app.use(httpLoggerMiddleware);
app.use('/api', rateLimiterMiddleware);

// Security & Body Parsing Middleware
app.use(compression());
app.use(helmet({ contentSecurityPolicy: false }));
const allowedOrigins = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(o => o.trim()) : '*';
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins === '*' || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(null, false);
  }
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve standalone demo page on /, /admin, and /demo
app.use('/', express.static(path.join(__dirname, '../public')));
app.use('/admin', express.static(path.join(__dirname, '../public')));
app.use('/demo', express.static(path.join(__dirname, '../public')));

// Config controller
const configController = require('./controllers/config');

// Fast non-DB routes (/api/config, /config, /api/health, /health)
app.get('/api/config', configController.getConfig);
app.get('/config', configController.getConfig);
app.get('/api/health', (req, res) => res.json({ status: 'ok', db: true }));
app.get('/health', (req, res) => res.json({ status: 'ok', db: true }));
app.get('/api/health/db', async (req, res) => {
  try {
    initCosmosClient();
    return res.json({ ok: true, driver: 'azure-cosmos-sdk' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Ensure DB is initialized before processing requests
app.use((req, res, next) => {
  try {
    initCosmosClient();
    next();
  } catch (err) {
    res.status(500).json({ error: 'Database client initialization failed.', details: err.message });
  }
});

// DB connection is handled lazily per request in middleware above

// Mount Swagger Documentation UI
try {
  const swaggerDocument = YAML.load(path.join(__dirname, 'swagger/swagger.yaml'));
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
} catch (err) {
  logger.error('Failed to load Swagger specification:', { error: err.message, stack: err.stack });
}

// Mount Central API Routes (supports both /api prefix and direct routes)
app.use('/api', apiRoutes);
app.use('/', apiRoutes);

// Fallback to Angular SPA index.html for deep links
app.get(['/map', '/search', '/intake'], (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Catch 404
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found.' });
});

// Centralized Error Handler
app.use((err, req, res, _next) => {
  logger.error('Central API Error:', { error: err.message, stack: err.stack });
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error'
  });
});

module.exports = app;
