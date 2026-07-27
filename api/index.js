'use strict';

const { app } = require('@azure/functions');
const http = require('http');
const net = require('net');
const mockSocket = new net.Socket();

let cachedExpressApp = null;

function getExpressApp() {
  if (cachedExpressApp) return cachedExpressApp;
  cachedExpressApp = require('../src/app');
  return cachedExpressApp;
}

async function handleExpress(request, context) {
  console.log('[expressApi] Incoming request:', request.method, request.url);
  context.log('[expressApi] Handled request:', request.method, request.url);
  try {
    const expressApp = getExpressApp();
    const url = new URL(request.url);
    console.log('[expressApi] Parsed URL pathname:', url.pathname, 'search:', url.search);
    
    let bodyBuffer = null;
    if (['POST', 'PUT', 'PATCH'].includes(request.method.toUpperCase())) {
      const arrayBuffer = await request.arrayBuffer();
      if (arrayBuffer && arrayBuffer.byteLength > 0) {
        bodyBuffer = Buffer.from(arrayBuffer);
      }
    }

    const reqHeaders = {};
    for (const [key, value] of request.headers.entries()) {
      reqHeaders[key.toLowerCase()] = value;
    }

    return new Promise((resolve) => {
      const req = new http.IncomingMessage(mockSocket);
      req.method = request.method;
      req.url = url.pathname + url.search;
      req.originalUrl = url.pathname + url.search;
      req.headers = reqHeaders;
      req.query = Object.fromEntries(url.searchParams.entries());

      if (bodyBuffer) {
        req.push(bodyBuffer);
      }
      req.push(null);

      const res = new http.ServerResponse(req);
      const chunks = [];

      res.write = (chunk, encoding, callback) => {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
        if (typeof callback === 'function') callback();
        return true;
      };

      res.end = (chunk, encoding, callback) => {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
        if (typeof callback === 'function') callback();
        
        const responseHeaders = {};
        const rawHeaders = res.getHeaders();
        for (const [k, v] of Object.entries(rawHeaders)) {
          responseHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v);
        }

        const responseBody = Buffer.concat(chunks);
        resolve({
          status: res.statusCode || 200,
          headers: responseHeaders,
          body: responseBody
        });
      };

      expressApp(req, res);
    });
  } catch (err) {
    context.error('[expressApi] Adapter Error:', err);
    return {
      status: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: err.message || 'Internal Server Error', stack: err.stack })
    };
  }
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

