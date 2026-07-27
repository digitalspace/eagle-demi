'use strict';

const nodeCrypto = require('crypto');
if (!globalThis.crypto || !globalThis.crypto.getRandomValues) {
  try {
    globalThis.crypto = nodeCrypto.webcrypto || nodeCrypto;
  } catch (e) {}
}

const express = require('express');
const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');
const mongoose = require('mongoose');
const path = require('path');
const YAML = require('yamljs');
const swaggerUi = require('swagger-ui-express');

const config = require('./config');
const { logger } = require('./utils/logger');

// Load Mongoose Models early (especially Log model for capped transport)
require('./models/log');
require('./models/project');
require('./models/document');
require('./models/region');
require('./models/boundary');

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
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
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
app.get('/api/health', (req, res) => res.json({ status: 'ok', db: mongoose.connection.readyState === 1 }));
app.get('/health', (req, res) => res.json({ status: 'ok', db: mongoose.connection.readyState === 1 }));
app.get('/api/health/db', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      await ensureDbConnected();
    }
    return res.json({ ok: true, state: mongoose.connection.readyState });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, name: err.name, code: err.code });
  }
});

// Database Connection helper for serverless execution
let connectionPromise = null;
async function ensureDbConnected() {
  if (mongoose.connection.readyState === 1) return;
  if (!connectionPromise) {
    logger.info('Initiating connection to Central DEMI MongoDB / Cosmos DB...');
    connectionPromise = mongoose.connect(config.mongoUri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
      family: 4,
      autoIndex: false
    }).then(conn => {
      logger.info('Successfully connected to Central DEMI MongoDB / Cosmos DB');
      return conn;
    }).catch(err => {
      connectionPromise = null;
      logger.error('Error connecting to Central DEMI MongoDB / Cosmos DB:', { error: err.message, stack: err.stack });
      throw err;
    });
  }
  return connectionPromise;
}

// Ensure DB is connected before processing requests (except fast non-DB endpoints)
app.use(async (req, res, next) => {
  const p = req.path || req.originalUrl || '';
  if (p.includes('/config') || p.includes('/health')) {
    return next();
  }
  try {
    await ensureDbConnected();
    next();
  } catch (err) {
    res.status(500).json({ error: 'Database connection failed.', details: err.message });
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
