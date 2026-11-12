'use strict';

/**
 * One dispatcher behind the Functions catch-all route. The host matches routes in discovery order,
 * not by specificity, so only one catch-all plus the table in ./routes.js routes predictably.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const querystring = require('querystring');
const { PassThrough, Readable } = require('stream');

const { logger, runWithRequestId } = require('../utils/logger');
const { logRequest } = require('../middleware/http-logger');
const { fromGateway, isValidApiKey } = require('../helpers/auth');
const { searchServiceReply } = require('../helpers/response');
const { fromEdge } = require('../utils/caller-ip');
const rotatingSecret = require('../utils/rotating-secret');
const config = require('../config');
const routes = require('./routes');

/** Matches `express.json({ limit: '10mb' })`, the ceiling the ingest routes were sized against. */
const BODY_LIMIT = 10 * 1024 * 1024;
/** The Functions host's own request cap; an upload past it never reaches the worker anyway. */
const MULTIPART_LIMIT = 100 * 1024 * 1024;

/**
 * Null-body statuses. undici rejects any body for these, even '', and the host then serves an empty
 * 500, so dispatch() drops the body for every route.
 */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

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

// CORS_ORIGIN is a comma-separated allowlist, set by api-function-flex.bicep. The fallback is narrow,
// not '*', so a missing setting removes access rather than the check.
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

/** The path the route table sees. */
function routePath(pathname) {
  // Strip one leading `/api` only: APIM forwards to the app under `/api`, while direct calls to the
  // function host, such as the deploy health check, use the bare path.
  let target = pathname;
  if (target === '/api') target = '/';
  else if (target.startsWith('/api/')) target = target.slice(4);
  if (target.length > 1) target = target.replace(/\/+$/, '') || '/';
  return target;
}

/**
 * @returns {object|null} the matched route with its `params`, or null for a 404.
 */
function match(method, pathname) {
  const target = routePath(pathname);

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

/**
 * The response surface the controllers use. Bodies are buffered, except one handed to `stream()`,
 * which dispatch passes on as a Node readable (an AsyncIterable body to the host).
 */
function makeRes(requestId) {
  const headers = { ...SECURITY_HEADERS, 'x-request-id': requestId };

  const finish = (body, defaultType) => {
    if (res.finished) return res;
    res.finished = true;
    if (defaultType && !headers['content-type']) headers['content-type'] = defaultType;
    res.body = body;
    // An empty body keeps a preset length: HEAD states the size of the file it stands for, and
    // null means unknown, so the header is left out.
    if (body || headers['content-length'] === undefined) {
      headers['content-length'] = String(Buffer.byteLength(body || ''));
    } else if (headers['content-length'] === null) {
      delete headers['content-length'];
    }
    if (res._done) res._done();
    return res;
  };

  const res = {
    statusCode: 200,
    headers,
    body: undefined,
    finished: false,
    streamed: false,
    /** Resolves the guard chain when a guard answers instead of calling next(). */
    _done: null,
    status(code) { res.statusCode = code; return res; },
    set(name, value) { headers[String(name).toLowerCase()] = value; return res; },
    get(name) { return headers[String(name).toLowerCase()]; },
    type(value) { return res.set('content-type', MIME[value] || value); },
    json(data) { return finish(JSON.stringify(data), MIME.json); },
    send(body) { return finish(body, MIME.html); },
    /**
     * Sends a Node readable as the body. Content-Length stays as preset; unset or null leaves it
     * out, since the size is not known here.
     */
    stream(readable, { status } = {}) {
      if (res.finished) return res;
      if (status) res.statusCode = status;
      if (headers['content-length'] == null) delete headers['content-length'];
      else headers['content-length'] = String(headers['content-length']);
      if (!headers['content-type']) headers['content-type'] = 'application/octet-stream';
      res.finished = true;
      res.streamed = true;
      res.body = guardStream(readable, requestId);
      if (res._done) res._done();
      return res;
    },
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
 * Wraps a handler's readable so a source error, which can only come after the headers, is logged
 * and ends the body short rather than surfacing as an unhandled 'error' event.
 */
function guardStream(readable, requestId) {
  const out = new PassThrough();
  readable.on('error', (err) => {
    logger.error('Response stream failed after headers were sent', { requestId, evt: 'stream-error', error: err.message, stack: err.stack });
    out.end();
  });
  // A client that goes away cancels `out`; release the store connection behind it too.
  out.on('close', () => readable.destroy());
  readable.pipe(out);
  return out;
}

/**
 * Everything about the request that does not need the body read, so a request that fails while
 * parsing its body still has something to log.
 */
function baseReq(request, url, headers, requestId) {
  const contentType = mediaType(headers);
  return {
    id: requestId,
    method: request.method,
    url: url.pathname + url.search,
    originalUrl: url.pathname + url.search,
    headers,
    // Repeated keys must stay arrays: eagle-public sends one `and[key]=value` per selected facet
    // option, and `Object.fromEntries(searchParams)` would keep only the last.
    query: querystring.parse(url.search.replace(/^\?/, '')),
    params: {},
    body: undefined,
    user: undefined,
    header: (name) => headers[String(name).toLowerCase()],
    is: (type) => (contentType === String(type).toLowerCase() ? type : false)
  };
}

function tooLarge() {
  return httpError(413, 'request entity too large');
}

/**
 * The request body as a stream that errors once it passes `limit` bytes, so a chunked body with no
 * content-length stops at the limit too. A client that drops mid-body is a 400, not a logged 500.
 */
function countedBody(request, headers, limit) {
  if (Number(headers['content-length']) > limit) throw tooLarge();
  const reader = request.body ? request.body.getReader() : null;
  let size = 0;
  return new ReadableStream({
    async pull(controller) {
      let next;
      try {
        next = reader ? await reader.read() : { done: true };
      } catch {
        return controller.error(httpError(400, 'request body aborted'));
      }
      if (next.done) return controller.close();
      size += next.value.byteLength;
      if (size > limit) {
        reader.cancel().catch(() => {});
        return controller.error(tooLarge());
      }
      controller.enqueue(next.value);
    },
    cancel: (reason) => reader && reader.cancel(reason)
  });
}

async function readBody(request, headers) {
  const chunks = [];
  for await (const chunk of countedBody(request, headers, BODY_LIMIT)) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function mediaType(headers) {
  return String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
}

/** The last file part lands in os.tmpdir() as `req.file`; dispatch() deletes it when the request ends. */
async function readMultipart(req, request) {
  const counted = countedBody(request, req.headers, MULTIPART_LIMIT);
  // undici answers a malformed body with TypeError; anything else (413, abort, allocation) keeps its own status.
  const form = await new Response(counted, { headers: { 'content-type': req.headers['content-type'] } }).formData()
    .catch((err) => { throw err instanceof TypeError ? httpError(400, 'invalid multipart body') : err; });
  req.body = {};
  let upload = null;
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') req.body[name] = value;
    else upload = value;
  }
  if (!upload) return;
  // Set before the write, so a write that fails halfway still leaves dispatch() a path to delete.
  req.file = { originalname: upload.name, mimetype: upload.type, size: upload.size, path: path.join(os.tmpdir(), crypto.randomUUID()) };
  await fs.promises.writeFile(req.file.path, upload.stream(), { mode: 0o600, flag: 'wx' });
}

/** Runs after the guards: none of them reads the body, so a refused caller never makes us buffer one. */
async function attachBody(req, request, route) {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const type = mediaType(req.headers);

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
  if (type === 'multipart/form-data') {
    if (!route.multipart) throw httpError(415, 'multipart bodies are only accepted on the upload route');
    return readMultipart(req, request);
  }

  // Everything else is left unread — the NDJSON chunk ingest consumes req.stream itself, which is
  // true streaming rather than the full buffer the old adapter forced on it.
  req.stream = request.body ? Readable.fromWeb(request.body) : Readable.from([]);
}

function applyCors(origin, res) {
  res.set('vary', 'Origin');
  // Browsers hide every response header from cross-origin JS except a six-name safelist, so the
  // paging token the API hands out would be unreadable by the client it is meant for.
  res.set('access-control-expose-headers', 'x-continuation-token, x-total-count');
  if (origin && (allowAnyOrigin || allowedOrigins.includes(origin))) {
    res.set('access-control-allow-origin', origin);
  }
}

/** Fixed text so one KQL `has` filter finds every line; the variable parts go in path and reason. */
const EDGE_GATE_MESSAGE = '[demi-api] edge gate: request did not come through Front Door';
const EDGE_GATE_MODES = new Set(['log', 'enforce']);
// Liveness probes skip the vault wait, so a cold start answers them at once.
const SKIP_SECRET_WAIT = new Set(['/health', '/health/db']);

/**
 * Why this request skipped Front Door, or null when it did not. Keyed callers (APIM subscription,
 * valid X-Api-Key) may skip it; the key is checked here as passiveAuth treats a bad one as anonymous.
 */
async function edgeGateReason(req, pathname) {
  const target = routePath(pathname);
  if (target === '/health' || target.startsWith('/health/')) return null;
  if (!fromGateway(req)) return 'no-gateway';
  const { headers } = req;
  if (fromEdge(headers) || headers['x-apim-subscription']) return null;
  if (headers['x-api-key'] === undefined) return 'no-edge';
  return (await isValidApiKey(headers['x-api-key'])) ? null : 'bad-key';
}

async function removeUpload(file) {
  try {
    await fs.promises.unlink(file);
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn('upload temp file not removed', { evt: 'upload-cleanup', file, error: err.message, stack: err.stack });
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
 * The Functions HTTP handler. Returns an HttpResponseInit; a streamed answer's body is a Node readable.
 */
async function dispatch(request, context) {
  const started = process.hrtime.bigint();
  const url = new URL(request.url);

  const headers = {};
  for (const [name, value] of request.headers.entries()) headers[name.toLowerCase()] = value;

  // Reuse a caller's trace id (eagle-api or any caller sending x-request-id): one request, one id.
  const ownId = crypto.randomUUID().slice(0, 8);
  const requestId = headers['x-request-id'] || headers['x-correlation-id'] || ownId;

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
        if (route && !SKIP_SECRET_WAIT.has(routePath(url.pathname))) await rotatingSecret.ready();
        const gateReason = route && EDGE_GATE_MODES.has(config.edgeGate)
          ? await edgeGateReason(req, url.pathname) : null;
        if (!route) {
          res.status(404).json({ error: 'Endpoint not found.' });
        } else if (gateReason && config.edgeGate === 'enforce') {
          res.status(403).json({ error: 'Forbidden. Use the public site address.' });
        } else {
          if (gateReason) {
            logger.warn(EDGE_GATE_MESSAGE, { evt: 'edge-gate', path: url.pathname, reason: gateReason });
          }
          req.params = route.params;
          await runGuards(route.guards, req, res);
          if (!res.finished) {
            await attachBody(req, request, route);
            await route.load()(req, res);
          }
        }
      }
    } catch (err) {
      const searchReply = searchServiceReply(err);
      const status = searchReply ? searchReply.status : err.status || 500;
      // A 4xx is caller error; the access log below records it at warn.
      if (status >= 500 || searchReply) logger.error('Central API Error:', { error: err.message, stack: err.stack });
      if (!res.finished) {
        res.status(status).json({ error: searchReply ? searchReply.error : status >= 500 ? 'Internal Server Error' : err.message });
      }
    } finally {
      if (req.file) await removeUpload(req.file.path);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      // A logging failure must never turn a served response into an error.
      try {
        logRequest(req, res, ms);
      } catch (err) {
        (context && context.error ? context.error : console.error)('[demi-api] request log failed', err);
      }
    }

    // After logRequest, so the access log still reports the byte count the handler produced.
    const nullBody = NULL_BODY_STATUSES.has(res.statusCode);
    if (nullBody) delete res.headers['content-length'];

    // A shared cache would replay one caller's id to everyone after, so the answer carries ours and
    // this line ties the two together.
    if (requestId !== ownId && /^\s*public\b/i.test(String(res.headers['cache-control'] || ''))) {
      res.headers['x-request-id'] = ownId;
      logger.info('request id replaced on a public answer',
        { evt: 'request-id-replaced', callerId: requestId, servedId: ownId });
    }

    const noBody = nullBody || request.method === 'HEAD';
    if (noBody && res.streamed) res.body.destroy();

    return { status: res.statusCode, headers: res.headers, body: noBody ? undefined : res.body };
  });
}

// makeRes is exported so controller tests use the real response, not a hand-rolled double that
// answers twice silently and skips serialisation.
module.exports = { dispatch, makeRes };
