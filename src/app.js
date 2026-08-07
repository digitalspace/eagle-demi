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
const cosmos = require('./db/cosmos-nosql');
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

// Readiness — actually reaches the database. ping() returns FALSE rather than throwing when the
// account is unconfigured, so a truthy check is required; `try/catch` alone is not enough.
app.get('/api/health/db', async (req, res) => {
  try {
    const ok = await cosmos.ping();
    if (!ok) {
      return res.status(503).json({ ok: false, error: 'Database client is not configured.' });
    }
    return res.json({ ok: true, driver: 'cosmos-db-nosql' });
  } catch (err) {
    // Unauthenticated route: a Cosmos SDK failure message carries the account endpoint and the
    // database and container names. The detail goes to the log, not to the caller.
    logger.error('Health check failed', { error: err.message, stack: err.stack });
    return res.status(503).json({ ok: false, error: 'Database unavailable.' });
  }
});

// No per-request database init. The Mongo client needed one because it connected eagerly; the
// NoSQL client builds its container handles lazily on first use, so a middleware that only
// primed the connection would cost every request a branch and buy nothing.

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

// A standalone copy of the frontend used to be served here: express.static on `/`, `/admin` and
// `/demo`, plus a res.sendFile SPA fallback for `/map`, `/search` and `/intake`. All of it is gone,
// and the sendFile half is the reason this comment is long enough to read before adding it back.
//
// It served from `../public`, which is UNTRACKED — no clone has it, so nothing was ever there in
// Azure. The three static mounts therefore fell through to the 404 below and were dead weight. The
// sendFile routes did worse: measured on dev 2026-08-06, `GET /map` returned NO RESPONSE AT ALL for
// 90 s, and the platform holds such a request for its full 240 s timeout. Three unauthenticated
// routes that each pin a request that long is a real cost on a single-worker B1.
//
// **Never use res.sendFile (or any streaming response) under the Functions adapter.** `api/index.js`
// fabricates `res` as a bare EventEmitter and resolves its promise INSIDE `res.end`. res.json and
// res.send reach it; `send`, which sendFile delegates to, streams instead and — on the missing-file
// error path — never calls it, so nothing resolves and the request hangs rather than failing.
// Under a real http.Server the same request fails fast with a 500 carrying the ENOENT, which is why
// this could only be found by asking the deployed API rather than by running it locally.
//
// The frontend is its own App Service (`demi-frontend-dev`), which is where these paths already
// live. There is nothing for the API to serve.

// Catch 404
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found.' });
});

// Centralized Error Handler
app.use((err, req, res, _next) => {
  logger.error('Central API Error:', { error: err.message, stack: err.stack });
  res.status(err.status || 500).json({
    error: 'Internal Server Error'
  });
});

module.exports = app;
