'use strict';

/**
 * Regression test for the Azure Functions → Express adapter (`api/index.js`).
 *
 * The adapter hands Express a hand-built `req`. Express reparents that object onto
 * http.IncomingMessage.prototype, whose `_destroy()` calls `this.socket.destroy()`. When `req` was
 * a plain Readable with `socket = {remoteAddress}`, reaching EOF auto-destroyed the stream and
 * threw `TypeError: this.socket.destroy is not a function` from a MICROTASK — past every
 * try/catch in the adapter and in Express. The Node worker died and the Functions host answered
 * 500 with an empty body.
 *
 * GET hid it completely: nothing reads the body, so the stream never ends. Every POST/PUT/PATCH
 * carrying a parseable body was broken in production and no test noticed, because the unit tests
 * call controllers directly and never build a request this way.
 *
 * These tests drive a real Express app through the same construction the adapter uses.
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { Readable } = require('stream');
const EventEmitter = require('events');

/** Mirrors api/index.js — keep the two in step. */
function buildReq({ method = 'POST', url = '/x', headers = {}, body = null }) {
  let bodyBuffer = body;

  const req = new Readable({
    autoDestroy: false,
    read() {
      if (bodyBuffer) { this.push(bodyBuffer); bodyBuffer = null; } else { this.push(null); }
    }
  });

  const socket = Object.assign(new EventEmitter(), {
    remoteAddress: '127.0.0.1',
    readable: false,
    writable: false,
    destroyed: false,
    destroy() { this.destroyed = true; },
    setTimeout() { return this; },
    unref() { return this; },
    ref() { return this; }
  });

  Object.assign(req, {
    method, url, originalUrl: url, headers, query: {}, socket, connection: socket
  });
  return req;
}

function buildRes(done) {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.headersSent = false;
  const chunks = [];
  res.setHeader = (n, v) => { res.headers[n.toLowerCase()] = v; return res; };
  res.getHeader = n => res.headers[n.toLowerCase()];
  res.removeHeader = n => { delete res.headers[n.toLowerCase()]; };
  res.writeHead = (s, h) => {
    res.statusCode = s;
    if (h) for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.headersSent = true;
    return res;
  };
  res.write = c => { if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); return true; };
  res.end = c => {
    if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    done({ status: res.statusCode, body: Buffer.concat(chunks).toString() });
  };
  return res;
}

function app() {
  const a = express();
  a.use(express.json({ limit: '10mb' }));
  a.post('/x', (req, res) => res.json({ ok: true, got: req.body }));
  a.use((err, req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return a;
}

/** Resolves with the response, or rejects if the request dies without one. */
function run(req) {
  return new Promise((resolve, reject) => {
    const onCrash = err => reject(err);
    process.once('uncaughtException', onCrash);
    const res = buildRes(result => {
      process.removeListener('uncaughtException', onCrash);
      resolve(result);
    });
    app()(req, res);
    setTimeout(() => {
      process.removeListener('uncaughtException', onCrash);
      reject(new Error('no response — res.end() was never called'));
    }, 3000).unref();
  });
}

test('functions adapter request shim', async (t) => {
  await t.test('a JSON body is parsed and answered, not crashed on', async () => {
    const body = Buffer.from(JSON.stringify({ markdown: 'hello' }));
    const res = await run(buildReq({
      headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
      body
    }));

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(JSON.parse(res.body).got, { markdown: 'hello' });
  });

  await t.test('a body-parser error becomes a 400, not a dead worker', async () => {
    // This is the exact shape that killed production: the error path reaches
    // IncomingMessage._destroy (and on-finished's socket.on) with the shim's fake socket.
    const body = Buffer.from(JSON.stringify({ markdown: 'hello' }));
    const res = await run(buildReq({
      headers: {
        'content-type': 'application/json',
        'content-length': String(body.length + 5) // lies — forces the failure path
      },
      body
    }));

    assert.strictEqual(res.status, 400);
    assert.match(JSON.parse(res.body).error, /content length/i);
  });

  await t.test('an empty JSON body still answers', async () => {
    const res = await run(buildReq({
      headers: { 'content-type': 'application/json', 'content-length': '0' },
      body: null
    }));

    assert.strictEqual(res.status, 200);
  });
});
