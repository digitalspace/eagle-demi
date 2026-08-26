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
const fs = require('fs');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cosmos = require('./db/cosmos-nosql');
const config = require('./config');
const { logger } = require('./utils/logger');

const apiRoutes = require('./routes/api');

// Initialize Express
const app = express();

// The Azure Functions HTTP adapter cannot construct a 304 response — undici's Response
// constructor rejects null-body status codes — so any conditional GET the browser revalidates
// (Express JSON ETags, swagger-ui static assets) became a 500 in Azure. Stripping the
// conditional headers means Express never short-circuits to 304; disabling etag stops inviting
// revalidation in the first place. Measured live on demi-api-test 2026-08-11.
app.set('etag', false);
app.use((req, _res, next) => {
  delete req.headers['if-none-match'];
  delete req.headers['if-modified-since'];
  next();
});

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
//
// NO compression(). Its zlib stream emits multi-chunk writes, and the Azure Functions HTTP
// adapter cannot reassemble them — any compressed response past a few chunks (swagger-ui.css
// at 179 KB, large search pages) hangs or 500s. Measured 2026-08-11: identical request with
// Accept-Encoding: identity answered 200 in 0.8 s; with gzip it timed out. Small JSON slipped
// under the 1 KB threshold, which is why the API looked healthy from curl. Both dev and test
// exhibited it — this was latent since the Azure move, not a migration regression.
app.use(helmet({ contentSecurityPolicy: false }));
// CORS_ORIGIN is a comma-separated allowlist. It was unset in every deployed environment,
// which silently meant "reflect ANY origin". Fall back to something narrow rather than to
// '*', so a missing env var removes access instead of removing the check.
//
// The deployed frontends used to be listed here. They cannot be any more: since the move to
// a Storage static website behind Front Door, the browser origin is an AFD endpoint whose
// hostname carries a hash assigned at deploy time — unknowable to this file, and supplied by
// CORS_ORIGIN (api-web-app.bicep sets it from the frontendHostName parameter). What is left
// is the local dev server, so an unset CORS_ORIGIN allows no deployed origin at all: the
// frontend breaks visibly in one request, which is the failure you want over the silent one.
const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:4200'];

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

// Mounted ahead of everything that needs the database. /api/health and /health are genuinely
// non-DB; /api/config reads the `config` container but falls back to its app settings when that
// read fails, so it answers whether or not Cosmos does.
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

// Mount Swagger Documentation UI.
//
// `swaggerUi.serve` is [init-js generator, express.static]. The static half STREAMS, and streamed
// responses hang forever under the Azure Functions HTTP adapter (measured 2026-08-11 — the UI HTML
// loaded but every css/js asset timed out, so the page never rendered). The buffered handler below
// answers first for every file that exists in swagger-ui-dist, so the static half never runs; what
// does run is the generator, because swagger-ui-init.js is generated and is not on disk. Do not
// drop `swaggerUi.serve` — /api-docs 404s on its own init script without it.
// Buffered res.send() is the one response shape the adapter handles, so the dist assets are
// read whole and sent whole. They total ~1.5 MB and are served a handful of times a day.
//
// NOT MOUNTED IN PROD. The UI is unauthenticated and the spec it renders names every route,
// parameter and role in the system, so prod 404s the path like any other unknown route.
// `config.environmentName` is the ENVIRONMENT app setting — see src/config.js.
if (config.environmentName !== 'prod') {
  try {
    const swaggerDocument = YAML.load(path.join(__dirname, 'swagger/swagger.yaml'));
    const swaggerDistPath = require('swagger-ui-dist').getAbsoluteFSPath();
    app.use('/api-docs', (req, res, next) => {
      const file = path.basename(req.path); // basename: no traversal
      const full = path.join(swaggerDistPath, file);
      if (file === '' || !fs.existsSync(full) || !fs.statSync(full).isFile()) return next();
      res.type(path.extname(file)).send(fs.readFileSync(full));
    });
    app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
  } catch (err) {
    logger.error('Failed to load Swagger specification:', { error: err.message, stack: err.stack });
  }
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
// The frontend is a Storage static website behind Front Door, which is where these paths already
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
