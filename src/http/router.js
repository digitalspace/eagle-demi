'use strict';

/**
 * The HTTP layer: one dispatcher behind the Functions host's catch-all route.
 *
 * Azure Functions matches routes in discovery order rather than by specificity (host issue #9876),
 * so per-route `app.http` registrations plus a fallback are non-deterministic. One catch-all and
 * the table in ./routes.js is the only arrangement that routes predictably.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const querystring = require('querystring');
const { Readable } = require('stream');

const { logger, runWithRequestId } = require('../utils/logger');
const { logRequest } = require('../middleware/http-logger');
const routes = require('./routes');

/** Matches `express.json({ limit: '10mb' })`, the ceiling the ingest routes were sized against. */
const BODY_LIMIT = 10 * 1024 * 1024;

/**
 * Helmet's default header set, frozen at the values it emitted with `contentSecurityPolicy: false`.
 * CSP stays OFF: `src/controllers/nosql/link.js` serves HTML that was written for its absence.
 */
const SECURITY_HEADERS = Object.freeze({
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'origin-agent-cluster': '?1',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-dns-prefetch-control': 'off',
  'x-download-options': 'noopen',
  'x-frame-options': 'SAMEORIGIN',
  'x-permitted-cross-domain-policies': 'none',
  'x-xss-protection': '0'
});

// CORS_ORIGIN is a comma-separated allowlist. It was unset in every deployed environment, which
// silently meant "reflect ANY origin". The fallback is narrow rather than '*', so a missing env var
// removes access instead of removing the check — the frontend breaks visibly in one request.
//
// The deployed frontends cannot be listed here: since the move to a Storage static website behind
// Front Door the browser origin is an AFD endpoint whose hostname carries a deploy-time hash,
// supplied by CORS_ORIGIN (api-function-flex.bicep sets it from the frontendHostNames parameter).
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

const MIME = {
  html: 'text/html; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8'
};

/** `:name` becomes a single non-empty path segment. Compiled once, at module load. */
function compile(routePath) {
  const names = [];
  const source = routePath
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
      names.push(name);
      return '([^/]+)';
    });
  return { regex: new RegExp(`^${source}$`), names };
}

const TABLE = routes.map(route => ({ ...route, ...compile(route.path) }));

/**
 * @returns {object|null} the matched route with its `params`, or null for a 404.
 */
function match(method, pathname) {
  // One leading `/api` only: rproxy mounts this API at both `/api` and `/`, which is what the old
  // app got from mounting the same router twice.
  let target = pathname;
  if (target === '/api') target = '/';
  else if (target.startsWith('/api/')) target = target.slice(4);
  if (target.length > 1) target = target.replace(/\/+$/, '') || '/';

  // HEAD answers off the GET route and drops the body, as Express did.
  const verb = method === 'HEAD' ? 'get' : method.toLowerCase();

  for (const route of TABLE) {
    if (route.method !== verb) continue;
    const found = route.regex.exec(target);
    if (!found) continue;
    const params = {};
    route.names.forEach((name, i) => {
      try {
        params[name] = decodeURIComponent(found[i + 1]);
      } catch {
        // A malformed percent-escape (e.g. `%ZZ`) is caller error, not a server fault.
        throw httpError(400, 'Bad Request');
      }
    });
    return { ...route, params };
  }
  return null;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** The response surface the controllers use. Nothing streams: the host wants one buffered body. */
function makeRes(requestId) {
  const headers = { ...SECURITY_HEADERS, 'x-request-id': requestId };

  const finish = (body, defaultType) => {
    if (res.finished) return res;
    res.finished = true;
    if (defaultType && !headers['content-type']) headers['content-type'] = defaultType;
    res.body = body;
    headers['content-length'] = String(Buffer.byteLength(body || ''));
    if (res._done) res._done();
    return res;
  };

  const res = {
    statusCode: 200,
    headers,
    body: undefined,
    finished: false,
    /** Resolves the guard chain when a guard answers instead of calling next(). */
    _done: null,
    status(code) { res.statusCode = code; return res; },
    set(name, value) { headers[String(name).toLowerCase()] = value; return res; },
    get(name) { return headers[String(name).toLowerCase()]; },
    type(value) { return res.set('content-type', MIME[value] || value); },
    json(data) { return finish(JSON.stringify(data), MIME.json); },
    send(body) { return finish(body, MIME.html); },
    redirect(status, url) {
      if (typeof status === 'string') { url = status; status = 302; }
      res.statusCode = status;
      res.set('location', url);
      return finish('');
    }
  };
  res.setHeader = res.set;
  return res;
}

/**
 * Everything about the request that does not need the body read, so a request that fails while
 * parsing its body still has something to log.
 */
function baseReq(request, url, headers, requestId) {
  const contentType = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  return {
    id: requestId,
    method: request.method,
    url: url.pathname + url.search,
    originalUrl: url.pathname + url.search,
    headers,
    // `querystring.parse`, which is literally what Express's default 'simple' query parser resolves
    // to: repeated keys stay ARRAYS. `Object.fromEntries(searchParams)` keeps only the LAST value,
    // and eagle-public emits one `and[key]=value` per selected facet option — so multi-select
    // filters silently applied one option each, under a 200.
    query: querystring.parse(url.search.replace(/^\?/, '')),
    params: {},
    body: undefined,
    user: undefined,
    header: (name) => headers[String(name).toLowerCase()],
    is: (type) => (contentType === String(type).toLowerCase() ? type : false)
  };
}

async function readBody(request, headers) {
  if (Number(headers['content-length']) > BODY_LIMIT) throw httpError(413, 'request entity too large');
  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.length > BODY_LIMIT) throw httpError(413, 'request entity too large');
  return bytes.toString('utf8');
}

/** One multipart route (POST /documents/extract). The handler unlinks the file it is handed. */
async function readMultipart(req, request) {
  req.body = {};
  for (const [name, value] of (await request.formData()).entries()) {
    if (typeof value === 'string') {
      req.body[name] = value;
      continue;
    }
    const bytes = Buffer.from(await value.arrayBuffer());
    const file = path.join(os.tmpdir(), crypto.randomUUID());
    await fs.promises.writeFile(file, bytes);
    req.file = { originalname: value.name, mimetype: value.type, size: bytes.length, path: file };
  }
}

async function attachBody(req, request) {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();

  if (type === 'application/json' || type.endsWith('+json')) {
    const text = await readBody(request, req.headers);
    if (!text) { req.body = {}; return; }
    try { req.body = JSON.parse(text); }
    catch { throw httpError(400, 'invalid JSON body'); }
    return;
  }
  if (type === 'application/x-www-form-urlencoded') {
    req.body = querystring.parse(await readBody(request, req.headers));
    return;
  }
  if (type === 'multipart/form-data') return readMultipart(req, request);

  // Everything else is left unread — the NDJSON chunk ingest consumes req.stream itself, which is
  // true streaming rather than the full buffer the old adapter forced on it.
  req.stream = request.body ? Readable.fromWeb(request.body) : Readable.from([]);
}

function applyCors(origin, res) {
  res.set('vary', 'Origin');
  // Browsers hide every response header from cross-origin JS except a six-name safelist, so the
  // paging token the API hands out would be unreadable by the client it is meant for.
  res.set('access-control-expose-headers', 'x-continuation-token');
  if (origin && (allowAnyOrigin || allowedOrigins.includes(origin))) {
    res.set('access-control-allow-origin', origin);
  }
}

/** Guards are the existing `(req, res, next)` middleware, run unchanged. */
async function runGuards(guards, req, res) {
  for (const guard of guards) {
    await new Promise((resolve, reject) => {
      res._done = resolve;
      try {
        guard(req, res, (err) => (err ? reject(err) : resolve()));
      } catch (err) {
        reject(err);
      }
    });
    if (res.finished) break;
  }
  res._done = null;
}

/**
 * The Functions HTTP handler. Returns an HttpResponseInit — never a stream, never a 304.
 */
async function dispatch(request, context) {
  const started = process.hrtime.bigint();
  const url = new URL(request.url);

  const headers = {};
  for (const [name, value] of request.headers.entries()) headers[name.toLowerCase()] = value;

  // Reuse an upstream trace id (rproxy, eagle-api) so one request is one id end to end.
  const requestId = headers['x-request-id'] || headers['x-correlation-id'] ||
    crypto.randomUUID().slice(0, 8);

  const res = makeRes(requestId);
  applyCors(headers.origin, res);
  const req = baseReq(request, url, headers, requestId);

  return runWithRequestId(requestId, async () => {
    try {
      if (request.method === 'OPTIONS' && headers['access-control-request-method']) {
        res.set('access-control-allow-methods', 'GET,HEAD,PUT,PATCH,POST,DELETE');
        if (headers['access-control-request-headers']) {
          res.set('access-control-allow-headers', headers['access-control-request-headers']);
        }
        res.status(204).send('');
      } else {
        const route = match(request.method, url.pathname);
        if (!route) {
          res.status(404).json({ error: 'Endpoint not found.' });
        } else {
          req.params = route.params;
          await attachBody(req, request);
          await runGuards(route.guards, req, res);
          if (!res.finished) await route.load()(req, res);
        }
      }
    } catch (err) {
      const status = err.status || 500;
      // A 4xx here is caller error the route already classified (bad JSON, oversized body, a
      // malformed path segment) — the per-request access log below records it at warn, so an
      // error-level stack for something that isn't a server fault would just be noise.
      if (status >= 500) logger.error('Central API Error:', { error: err.message, stack: err.stack });
      if (!res.finished) res.status(status).json({ error: status >= 500 ? 'Internal Server Error' : err.message });
    } finally {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      // A logging failure must never turn a served response into an error.
      try {
        logRequest(req, res, ms);
      } catch (err) {
        (context && context.error ? context.error : console.error)('[demi-api] request log failed', err);
      }
    }

    return {
      status: res.statusCode,
      headers: res.headers,
      body: request.method === 'HEAD' ? undefined : res.body
    };
  });
}

// makeRes is exported for the controller suites: a hand-rolled `{ status, json }` double answers
// twice without complaining and reports objects the real one would have serialised, which is how a
// response assertion passes against a handler that sent something else.
module.exports = { dispatch, makeRes };
