'use strict';

const { app } = require('@azure/functions');
const { Readable } = require('stream');
const EventEmitter = require('events');

async function handleExpress(request, context) {
  return new Promise(async (resolve, reject) => {
    try {
      const urlObj = new URL(request.url);
      
      let bodyBuffer = null;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const arrayBuffer = await request.arrayBuffer();
        bodyBuffer = Buffer.from(arrayBuffer);
      }

      // 1. Construct Node.js Readable stream as req
      const req = new Readable({
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

      Object.assign(req, {
        method: request.method,
        url: urlObj.pathname + urlObj.search,
        originalUrl: urlObj.pathname + urlObj.search,
        headers: headers,
        query: Object.fromEntries(urlObj.searchParams.entries()),
        socket: { remoteAddress: headers['x-forwarded-for'] || '127.0.0.1' },
        connection: { remoteAddress: headers['x-forwarded-for'] || '127.0.0.1' }
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

app.timer('nightlySyncTimer', {
  schedule: '0 0 2 * * *',
  handler: async (myTimer, context) => {
    const log = context && context.log ? context.log : console.log;
    const errLog = context && context.error ? context.error : console.error;
    log('[Azure Timer] Nightly Sync Timer triggered at:', new Date().toISOString());
    try {
      const { runNightlySync } = require('../src/scripts/nightly-sync');
      await runNightlySync();
      log('[Azure Timer] Nightly Sync finished successfully.');
    } catch (err) {
      errLog('[Azure Timer] Nightly Sync failed with error:', err.message || err);
    }
  }
});

