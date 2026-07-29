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
// Rate limit ALL routes, not just /api — the router is mounted at both '/api' and '/'
// below, so limiting only the prefix left the root-mounted duplicates (including
// POST /db/import) completely unlimited.
app.use(rateLimiterMiddleware);

// Security & Body Parsing Middleware
app.use(compression());
app.use(helmet({ contentSecurityPolicy: false }));
// CORS_ORIGIN is a comma-separated allowlist. It was unset in every deployed environment,
// which silently meant "reflect ANY origin". Fall back to the known DEMI frontends rather
// than to '*', so a missing env var narrows access instead of removing it entirely.
const DEFAULT_ALLOWED_ORIGINS = [
  'https://demi-frontend-dev.azurewebsites.net',
  'https://demi-frontend-test.azurewebsites.net',
  'https://demi-frontend-prod.azurewebsites.net',
  'http://localhost:4200'
];

const corsOriginEnv = (process.env.CORS_ORIGIN || '').trim();
const allowAnyOrigin = corsOriginEnv === '*';
const allowedOrigins = corsOriginEnv && !allowAnyOrigin
  ? corsOriginEnv.split(',').map(o => o.trim()).filter(Boolean)
  : DEFAULT_ALLOWED_ORIGINS;

if (!corsOriginEnv) {
  logger.warn(
    `CORS_ORIGIN is not set — falling back to the default DEMI frontend allowlist ` +
    `(${allowedOrigins.join(', ')}). Set it explicitly per environment.`
  );
} else if (allowAnyOrigin) {
  logger.warn('CORS_ORIGIN is "*" — every origin is allowed. Do not use this in production.');
}

app.use(cors({
  origin: (origin, callback) => {
    // Same-origin / non-browser callers send no Origin header.
    if (!origin) return callback(null, true);
    if (allowAnyOrigin) return callback(null, true);
    return callback(null, allowedOrigins.includes(origin));
  }
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Config controller
const configController = require('./controllers/config');

// Fast non-DB routes (/api/config, /config, /api/health, /health)
app.get('/api/config', configController.getConfig);
app.get('/config', configController.getConfig);
// Liveness only — the process is up. Deliberately does NOT claim anything about the
// database; it previously reported `db: true` unconditionally, so every probe stayed green
// with no database configured at all.
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Readiness — actually reaches the database. initCosmosClient() RETURNS NULL rather than
// throwing when unconfigured, so a truthy check is required; `try/catch` alone is not enough.
app.get('/api/health/db', async (req, res) => {
  try {
    const db = initCosmosClient();
    if (!db) {
      return res.status(503).json({ ok: false, error: 'Database client is not configured.' });
    }
    await db.command({ ping: 1 });
    return res.json({ ok: true, driver: 'cosmos-db-mongodb-api' });
  } catch (err) {
    return res.status(503).json({ ok: false, error: err.message });
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

// Serve standalone demo page on /, /admin, and /demo (after API routes)
app.use('/', express.static(path.join(__dirname, '../public')));
app.use('/admin', express.static(path.join(__dirname, '../public')));
app.use('/demo', express.static(path.join(__dirname, '../public')));

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
