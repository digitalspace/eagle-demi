'use strict';

const { app } = require('@azure/functions');
const { Readable } = require('stream');
const EventEmitter = require('events');

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
        query: Object.fromEntries(urlObj.searchParams.entries()),
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

      res.end = (chunk) => {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        res.headersSent = true;
        const responseBuffer = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: responseBuffer
        });
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

