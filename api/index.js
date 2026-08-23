'use strict';

// Azure Monitor has to start before anything else is required. The distro instruments modules by
// hooking `require`, so any library loaded ahead of it — http, express, winston — is captured as
// the uninstrumented original and never reports.
//
// Guarded on the connection string so `yarn start` (src/server.js, plain Express) and the test
// suite run untouched: no connection string, no telemetry, no exporter retry noise in the console.
// Winston instrumentation is opt-in; the distro leaves it off by default, and it is the whole
// reason the existing logger's output reaches Application Insights at all.
if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
  const { useAzureMonitor } = require('@azure/monitor-opentelemetry');
  useAzureMonitor({
    // Performance counters off: they were 46.97 MB of a 84.68 MB/30d workspace ingest — the single
    // largest table — and every one of them (CPU, memory, request rate) is already collected free
    // as App Service platform metrics, which never enter the workspace and so are not subject to
    // its dailyQuotaGb cap either. Paying per-GB to duplicate a free metric is the whole of the loss.
    //
    // Standard metrics stay ON deliberately. They are the next-largest table (AppMetrics, 30.67 MB)
    // and killing them would save roughly a dollar a month, but they are what the Performance and
    // Failures blades read — request duration, dependency duration, failure rate. Platform metrics
    // do NOT cover those. Cutting them buys pennies and blinds the tool.
    enablePerformanceCounters: false,
    instrumentationOptions: {
      winston: { enabled: true }
    }
  });
}

const { app } = require('@azure/functions');
const { Readable } = require('stream');
const EventEmitter = require('events');
const querystring = require('querystring');

/**
 * The query object Express would have built — repeated keys become ARRAYS, not the last value.
 *
 * `Object.fromEntries(searchParams.entries())` silently keeps only the LAST occurrence of a
 * repeated key, and eagle-public repeats them as its normal encoding: `api.ts:186-196` emits one
 * `and[key]=value` PER selected option, so `and[region]=Peace&and[region]=Cariboo` reached the app
 * as Cariboo alone. Measured on the live test service: that URL answered 13 where prod eagle-search
 * answers 89. Every multi-select facet on every dataset had been quietly applying one option, under
 * a 200, since this adapter was written — indistinguishable from a filter that matched 13 rows.
 *
 * The same collapse ate sorting. `api.ts:176-177` appends `sortBy` TWICE and the second is
 * routinely the empty string, so `sortBy=-name&sortBy=` arrived as `''` — no sort asked for, which
 * also routed the request to the Cosmos list instead of the index. `eagle-query.sortEntries` was
 * written for exactly that double-append and never saw it.
 *
 * `querystring.parse` RATHER THAN A HAND-ROLLED LOOP, because it is not merely equivalent to what
 * Express does — it IS what Express does: `express/lib/application.js` sets `query parser` to
 * `'simple'` by default and `express/lib/utils.js` resolves that to this exact function. A copy
 * would be a second definition of "what Express would have parsed", free to drift from the one the
 * `yarn start` path actually uses. It also returns a NULL-PROTOTYPE object, so a query key named
 * `__proto__` or `constructor` is an ordinary own property rather than a prototype read.
 *
 * Nested `and[...]` keys stay FLAT — `andParams` reads both that and the `qs` nested form, and
 * changing which one arrives here changes nothing it can see.
 */
function queryFrom(searchParams) {
  return querystring.parse(searchParams.toString());
}

async function handleExpress(request, context) {
  // Not an async executor: a rejection thrown inside `new Promise(async ...)` is
  // swallowed rather than surfacing, so the async work is hoisted into its own
  // function and its rejection is wired to the promise explicitly.
  return new Promise((resolve, reject) => {
    (async () => {
    try {
      const urlObj = new URL(request.url);
      
      let bodyBuffer = null;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const arrayBuffer = await request.arrayBuffer();
        bodyBuffer = Buffer.from(arrayBuffer);
      }

      // 1. Construct Node.js Readable stream as req
      //
      // autoDestroy:false is load-bearing. Express reparents this object onto
      // http.IncomingMessage.prototype, whose _destroy() calls `this.socket.destroy()`. With the
      // default autoDestroy, reaching EOF fires that from a microtask the try/catch below cannot
      // see — so every request Express parsed a body for killed the worker and the Functions host
      // answered 500 with an empty body. GET was unaffected only because nothing read the stream.
      const req = new Readable({
        autoDestroy: false,
        read() {
          if (bodyBuffer) {
            this.push(bodyBuffer);
            bodyBuffer = null;
          } else {
            this.push(null);
          }
        }
      });

      const headers = {};
      for (const [key, value] of request.headers.entries()) {
        headers[key.toLowerCase()] = value;
      }

      // A real EventEmitter, not a bare object: on-finished (used by body-parser's error path,
      // and by anything else that wants to know when a request ended) calls socket.on(), and
      // Node's IncomingMessage internals call socket.destroy()/setTimeout(). A plain
      // {remoteAddress} throws on all three, and always from somewhere uncatchable.
      const socket = Object.assign(new EventEmitter(), {
        remoteAddress: headers['x-forwarded-for'] || '127.0.0.1',
        readable: false,
        writable: false,
        destroyed: false,
        destroy() { this.destroyed = true; },
        setTimeout() { return this; },
        unref() { return this; },
        ref() { return this; }
      });

      Object.assign(req, {
        method: request.method,
        url: urlObj.pathname + urlObj.search,
        originalUrl: urlObj.pathname + urlObj.search,
        headers: headers,
        query: queryFrom(urlObj.searchParams),
        socket,
        connection: socket
      });

      // 2. Construct ServerResponse event emitter as res
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      res.headersSent = false;

      const chunks = [];

      res.setHeader = (name, value) => {
        res.headers[name.toLowerCase()] = value;
        return res;
      };

      res.getHeader = (name) => res.headers[name.toLowerCase()];

      res.removeHeader = (name) => {
        delete res.headers[name.toLowerCase()];
      };

      res.writeHead = (statusCode, headersInput) => {
        res.statusCode = statusCode;
        if (headersInput) {
          for (const [k, v] of Object.entries(headersInput)) {
            res.setHeader(k, v);
          }
        }
        res.headersSent = true;
        return res;
      };

      res.write = (chunk) => {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        return true;
      };

      // A real ServerResponse emits 'finish' when the response is fully written, and ignores a
      // second end(). This object did neither: it resolved the host's promise and stopped. Anything
      // waiting on 'finish' — middleware/http-logger.js does all of its work there — simply never
      // ran in Azure, while working perfectly under `yarn start` on a genuine ServerResponse. The
      // per-request access log, the only record of a caller's identity, IP and latency, has never
      // existed in this environment.
      //
      // The emit happens BEFORE resolve so its listeners run while the worker is unambiguously
      // alive: once the promise resolves, the Functions host is free to recycle, and work deferred
      // past that point is not guaranteed to run.
      let finished = false;
      res.end = (chunk) => {
        // A second end() is ignored outright, as a real one is: emitting twice would double-count
        // every request and quietly inflate every number built on these rows.
        if (finished) return res;
        finished = true;

        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        res.headersSent = true;
        // on-finished (finalhandler, body-parser) reads this to decide whether a response has
        // already ended; without it, a listener attached after end() would never fire.
        res.finished = true;

        // A logging failure must never turn a served response into an error.
        try {
          res.emit('finish');
        } catch (err) {
          if (context && context.error) {
            context.error('[expressApi] finish listener failed:', err);
          } else {
            console.error('[expressApi] finish listener failed:', err);
          }
        }

        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks)
        });
        return res;
      };

      const expressApp = require('../src/app');
      expressApp(req, res);
    } catch (err) {
      if (context && context.error) {
        context.error('[expressApi] Adapter Error:', err);
      } else {
        console.error('[expressApi] Adapter Error:', err);
      }
      resolve({
        status: 500,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: err.message || 'Internal Server Error' })
      });
    }
    })().catch(reject);
  });
}

// Exported for test/functions-adapter.test.js, which drives this the way the host does. The
// adapter is the one piece of this app that only ever runs in Azure, so it is also the one piece
// nothing else can exercise — hence a test that calls it directly.
module.exports = { handleExpress, queryFrom };

// Drain buffered audit events before the worker goes away.
//
// src/utils/audit.js buffers events and flushes on a 1-second timer, which is correct for the
// long-lived Express process it was written against (`yarn start`) and wrong here: the Functions
// host owns this worker's lifecycle and recycles it on deploy, config change, scale and idle. Work
// deferred past a response is not guaranteed to run, and the flush timer is unref()'d, so it does
// not hold the process open either. Measured on the first staging deploy: events buffered at
// 21:50 were lost to the restart at 21:52.
//
// appTerminate covers graceful shutdown — deploys, restarts, scale-in, which is every recycle we
// have actually observed. Microsoft is explicit that it does not run on a forced kill and that
// handlers get a limited grace period, so this shortens the loss window rather than closing it.
// The remaining exposure is one flush interval, which is the ceiling already documented in audit.js.
//
// Registered here rather than in audit.js because this file is the only Azure-specific entry point:
// `yarn start` and the test suite import audit.js too, and neither has a Functions host to hook.
app.hook.appTerminate(async () => {
  const { flush } = require('../src/utils/audit');
  await flush();
});

app.http('expressApi', {
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
  authLevel: 'anonymous',
  route: '{*rest}',
  handler: handleExpress
});

app.http('expressApiRoot', {
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
  authLevel: 'anonymous',
  route: '',
  handler: handleExpress
});

// The nightlySyncTimer used to live here. Its script (src/scripts/nightly-sync.js) went with the
// Mongo data layer, and the AI Search indexers pull every five minutes, so there is nothing left
// for a nightly job to push. Registration survived the deletion because the require was lazy and
// wrapped in a catch — it failed silently once a night instead of at boot.

