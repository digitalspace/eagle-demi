'use strict';

const { app } = require('@azure/functions');
const expressApp = require('../src/app');

// Register Azure Functions v4 HTTP Trigger with native Express adapter
app.http('expressApi', {
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
  authLevel: 'anonymous',
  route: '{*segments}',
  handler: async (request, context) => {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;
      const search = url.search;

      // Extract body if present
      let bodyBuffer = null;
      if (['POST', 'PUT', 'PATCH'].includes(request.method.toUpperCase())) {
        const arrayBuffer = await request.arrayBuffer();
        if (arrayBuffer && arrayBuffer.byteLength > 0) {
          bodyBuffer = Buffer.from(arrayBuffer);
        }
      }

      // Convert request headers
      const reqHeaders = {};
      for (const [key, value] of request.headers.entries()) {
        reqHeaders[key.toLowerCase()] = value;
      }

      return new Promise((resolve) => {
        const { Readable, Writable } = require('stream');

        let pushed = false;
        const req = new Readable({
          read() {
            if (!pushed && bodyBuffer) {
              this.push(bodyBuffer);
              pushed = true;
            }
            this.push(null);
          }
        });

        const mockSocket = { remoteAddress: reqHeaders['x-forwarded-for'] || '127.0.0.1', encrypted: true };
        req.socket = mockSocket;
        req.connection = mockSocket;
        req.client = { socket: mockSocket };

        req.method = request.method;
        req.url = pathname + search;
        req.originalUrl = pathname + search;
        req.headers = reqHeaders;
        req.query = Object.fromEntries(url.searchParams.entries());

        const resHeaders = {};
        let statusCode = 200;
        const chunks = [];

        const res = new Writable({
          write(chunk, encoding, callback) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            callback();
          }
        });

        res.setHeader = (name, value) => {
          resHeaders[name.toLowerCase()] = String(value);
        };
        res.getHeader = (name) => resHeaders[name.toLowerCase()];
        res.removeHeader = (name) => { delete resHeaders[name.toLowerCase()]; };

        Object.defineProperty(res, 'statusCode', {
          get: () => statusCode,
          set: (val) => { statusCode = val; }
        });

        res.status = (code) => {
          statusCode = code;
          return res;
        };

        res.json = (data) => {
          res.setHeader('content-type', 'application/json; charset=utf-8');
          const payload = Buffer.from(JSON.stringify(data));
          chunks.push(payload);
          res.end();
        };

        res.send = (data) => {
          if (typeof data === 'object' && data !== null && !Buffer.isBuffer(data)) {
            return res.json(data);
          }
          if (typeof data === 'string') {
            if (!res.getHeader('content-type')) {
              res.setHeader('content-type', 'text/html; charset=utf-8');
            }
            chunks.push(Buffer.from(data));
          } else if (Buffer.isBuffer(data)) {
            chunks.push(data);
          }
          res.end();
        };

        let ended = false;
        res.end = (chunk) => {
          if (ended) return;
          ended = true;
          if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          const responseBody = Buffer.concat(chunks);
          resolve({
            status: statusCode,
            headers: resHeaders,
            body: responseBody
          });
        };

        // Invoke Express app
        expressApp(req, res);
      });
    } catch (err) {
      context.error('Express Function Adapter Error:', err);
      return {
        status: 500,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: err.message || 'Internal Server Error' })
      };
    }
  }
});
