'use strict';

/**
 * The request/response shim, on the paths no controller test can see.
 *
 * Everything here used to be Express's job — query parsing, multipart, the guard chain, redirects —
 * so it had no test in this repo at all. Each case below is a shape that silently degrades: a
 * multi-select filter that applies one option under a 200, an upload that arrives with no file, a
 * printed short link that stops redirecting.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const { Readable } = require('node:stream');
const { SUITE_KEY } = require('../helpers/suite-key');
const { HttpRequest, HttpResponse } = require('@azure/functions');

const { dispatch } = require('../../src/http/router');
const configController = require('../../src/controllers/config');
const documentController = require('../../src/controllers/nosql/document');
const links = require('../../src/repositories/links');
const healthController = require('../../src/controllers/health');
const searchSchemaController = require('../../src/controllers/search-schema');
const config = require('../../src/config');
const { logger } = require('../../src/utils/logger');

const AUTHED = { 'x-api-key': SUITE_KEY };

function call(path, init = {}) {
  return dispatch(new HttpRequest({
    method: init.method || 'GET',
    url: `http://127.0.0.1${path}`,
    headers: init.headers || {},
    body: init.body
  }), { error: () => {} });
}

test('repeated query keys stay arrays', async (t) => {
  // `Object.fromEntries(searchParams)` keeps only the LAST value, and eagle-public emits one
  // `and[key]=value` per selected facet option — so every multi-select filter quietly applied one
  // option, under a 200, indistinguishable from a filter that matched few rows.
  let seen;
  t.mock.method(configController, 'getConfig', (req, res) => { seen = req.query; res.json({}); });

  await call('/api/config?and[region]=Peace&and[region]=Cariboo&sortBy=-name&sortBy=');

  assert.deepStrictEqual(seen['and[region]'], ['Peace', 'Cariboo']);
  assert.deepStrictEqual(seen.sortBy, ['-name', '']);
});

test('route params are named and percent-decoded', async (t) => {
  let seen;
  t.mock.method(links, 'getById', async (id) => { seen = id; return null; });

  const res = await call('/s/ab%2Dc');
  assert.strictEqual(seen, 'ab-c', 'the handler reads a decoded :code, not the raw segment');
  assert.strictEqual(res.status, 404, 'an unknown code renders the not-found page');
  assert.match(res.headers['content-type'], /text\/html/);
});

test('a malformed percent-escape in a route param is a 400, not a 500', async () => {
  const res = await call('/s/%ZZ');
  assert.strictEqual(res.status, 400);
  assert.deepStrictEqual(JSON.parse(res.body), { error: 'Bad Request' });
});

test('a short link redirects with no-store, never a cached 301', async (t) => {
  // A cached permanent redirect on a printed poster can never be corrected.
  t.mock.method(links, 'getById', async () => ({ id: 'abc', url: 'https://example.gov.bc.ca/x' }));

  const res = await call('/s/abc');
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, 'https://example.gov.bc.ca/x');
  assert.strictEqual(res.headers['cache-control'], 'no-store');
});

test('an uncredentialed call to a guarded route is 401 and never reaches the handler', async (t) => {
  let reached = false;
  t.mock.method(documentController, 'createDocument', (req, res) => { reached = true; res.json({}); });

  const res = await call('/api/documents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { string: '{}' }
  });

  assert.strictEqual(res.status, 401);
  assert.strictEqual(reached, false, 'the guard chain must stop before the handler');
});

test('a multipart upload arrives as req.file', async (t) => {
  // The one multipart route. multer is gone; the dispatcher writes the part to os.tmpdir() and
  // synthesises the same four fields the handler reads, including the path it unlinks.
  let seen;
  t.mock.method(documentController, 'extractDocument', (req, res) => {
    seen = { file: req.file, body: req.body };
    res.status(202).json({});
  });

  const form = new FormData();
  form.set('project', '207');
  form.set('upfile', new File([Buffer.from('%PDF-1.4 fake')], 'plan.pdf', { type: 'application/pdf' }));
  const encoded = new Response(form);

  const res = await call('/api/documents/extract', {
    method: 'POST',
    headers: { ...AUTHED, 'content-type': encoded.headers.get('content-type') },
    body: { bytes: new Uint8Array(await encoded.arrayBuffer()) }
  });

  assert.strictEqual(res.status, 202);
  assert.strictEqual(seen.body.project, '207');
  assert.strictEqual(seen.file.originalname, 'plan.pdf');
  assert.strictEqual(seen.file.mimetype, 'application/pdf');
  assert.strictEqual(seen.file.size, 13);
  assert.ok(require('node:fs').existsSync(seen.file.path), 'the handler is handed a real path');
  require('node:fs').unlinkSync(seen.file.path);
});

test('a body over the 10 MB limit is refused before it is parsed', async (t) => {
  let reached = false;
  t.mock.method(documentController, 'createDocument', (req, res) => { reached = true; res.json({}); });

  const res = await call('/api/documents', {
    method: 'POST',
    headers: { ...AUTHED, 'content-type': 'application/json', 'content-length': String(11 * 1024 * 1024) },
    body: { string: '{}' }
  });

  assert.strictEqual(res.status, 413);
  assert.strictEqual(reached, false);
});

test('a malformed JSON body is a 400, not a 500', async () => {
  const res = await call('/api/documents', {
    method: 'POST',
    headers: { ...AUTHED, 'content-type': 'application/json' },
    body: { string: '{not json' }
  });
  assert.strictEqual(res.status, 400);
});

test('a null-body status is dispatched with no body and no content-length', async () => {
  // The Functions worker (api/index.js) hands this straight to `new Response(body, ...)`, and
  // undici throws `Invalid response status code 204` on any body — including the '' the shim's
  // send('') leaves behind — which the host then serves as an empty 500.
  const res = await call('/api/anything', {
    method: 'OPTIONS',
    headers: { origin: 'http://127.0.0.1', 'access-control-request-method': 'POST' }
  });

  assert.strictEqual(res.status, 204);
  assert.strictEqual(res.body, undefined, 'a 204 carries no body at all, not even an empty string');
  assert.strictEqual(res.headers['content-length'], undefined, 'a null-body status has no length');
  assert.doesNotThrow(() => new Response(res.body, { status: res.status, headers: res.headers }));
});

test('a 200 with an empty body still carries content-length: 0', async (t) => {
  t.mock.method(configController, 'getConfig', (req, res) => res.send(''));

  const res = await call('/api/config');

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body, '', 'only null-body statuses lose their body');
  assert.strictEqual(res.headers['content-length'], '0');
});

test('a streamed body arrives whole under the length the handler preset', async (t) => {
  t.mock.method(configController, 'getConfig', (req, res) => {
    res.set('Content-Length', 11);
    res.stream(Readable.from([Buffer.from('hello '), Buffer.from('world')]));
  });

  const res = await call('/api/config');
  // HttpResponse is what the host builds from dispatch's return value.
  const sent = new HttpResponse(res);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers['content-length'], '11', 'the preset length, not the length of an empty buffer');
  assert.strictEqual(await sent.text(), 'hello world');
});

test('a 304 the handler answers carries no body and no content-length', async (t) => {
  // A conditional GET states the file's size before it learns the copy is fresh; the 304 must drop
  // that length, or undici refuses the Response and the host serves an empty 500.
  t.mock.method(configController, 'getConfig', (req, res) => {
    res.set('Content-Length', 11).set('ETag', '"abc"');
    res.status(304).send('');
  });

  const res = await call('/api/config');

  assert.strictEqual(res.status, 304);
  assert.strictEqual(res.body, undefined);
  assert.strictEqual(res.headers['content-length'], undefined);
  assert.strictEqual(res.headers.etag, '"abc"');
  assert.doesNotThrow(() => new Response(res.body, { status: res.status, headers: res.headers }));
});

// Bounded: the failure mode is a body that never ends.
test('a stream answered as 304 sends nothing and releases its source', { timeout: 5000 }, async (t) => {
  // Never ends by itself, like a store read nobody consumes.
  const source = new Readable({ read() {} });
  t.mock.method(configController, 'getConfig', (req, res) => {
    res.set('Content-Length', 5);
    res.stream(source, { status: 304 });
  });

  const res = await call('/api/config');

  assert.strictEqual(res.status, 304);
  assert.strictEqual(res.body, undefined);
  assert.strictEqual(res.headers['content-length'], undefined);
  await once(source, 'close');
  assert.strictEqual(source.destroyed, true, 'an unread store stream would hold its connection open');
});

// Bounded: the failure mode is a body that never ends.
test('a stream that fails after the headers is logged and ends short', { timeout: 5000 }, async (t) => {
  const error = t.mock.method(logger, 'error', () => {});
  let sentFirst = false;
  const source = new Readable({
    read() {
      if (sentFirst) return this.destroy(new Error('store connection reset'));
      sentFirst = true;
      this.push('partial');
    }
  });
  t.mock.method(configController, 'getConfig', (req, res) => {
    res.set('Content-Length', 100);
    res.stream(source);
  });

  const res = await call('/api/config');
  const text = await new HttpResponse(res).text();

  assert.strictEqual(res.headers['content-length'], '100');
  assert.strictEqual(text, 'partial', 'the bytes read before the failure, then a clean end');
  const logged = error.mock.calls.map((c) => c.arguments[1]).find((meta) => meta && meta.evt === 'stream-error');
  assert.strictEqual(logged && logged.error, 'store connection reset');
});

test('edge gate', async (t) => {
  // Fake values: the gate compares what the request presents against these.
  const GATEWAY = { 'x-gateway-secret': 'gateway-secret-for-edge-gate-suite' };
  const EDGE = { 'x-edge-secret': 'edge-secret-for-edge-gate-suite' };
  const saved = { edgeGate: config.edgeGate, edgeSecret: config.edgeSecret };

  t.beforeEach((t) => {
    process.env.APIM_GATEWAY_SECRET = GATEWAY['x-gateway-secret'];
    config.edgeSecret = EDGE['x-edge-secret'];
    config.edgeGate = 'enforce';
    t.mock.method(configController, 'getConfig', (req, res) => res.json({ ok: true }));
  });
  t.afterEach(() => {
    delete process.env.APIM_GATEWAY_SECRET;
    Object.assign(config, saved);
  });

  const gateWarnings = (warn) =>
    warn.mock.calls.filter(c => String(c.arguments[0]).includes('edge gate'));

  await t.test('enforce refuses a direct call to the Function host', async () => {
    const res = await call('/api/config');
    assert.strictEqual(res.status, 403);
    assert.match(JSON.parse(res.body).error, /^Forbidden/);
  });

  await t.test('enforce refuses APIM without the edge secret', async () => {
    const res = await call('/api/config', { headers: { ...GATEWAY } });
    assert.strictEqual(res.status, 403);
  });

  await t.test('a wrong edge secret counts as no edge', async () => {
    const res = await call('/api/config', { headers: { ...GATEWAY, 'x-edge-secret': 'guess' } });
    assert.strictEqual(res.status, 403);
  });

  await t.test('the edge secret without APIM is refused', async () => {
    const res = await call('/api/config', { headers: { ...EDGE } });
    assert.strictEqual(res.status, 403);
  });

  await t.test('APIM plus the edge secret is served', async () => {
    const res = await call('/api/config', { headers: { ...GATEWAY, ...EDGE } });
    assert.strictEqual(res.status, 200);
  });

  await t.test('APIM plus a subscription name is served', async () => {
    const res = await call('/api/config', { headers: { ...GATEWAY, 'x-apim-subscription': 'eagle-api' } });
    assert.strictEqual(res.status, 200);
  });

  await t.test('APIM plus a valid X-Api-Key is served and reaches auth', async (t) => {
    t.mock.method(documentController, 'createDocument', (req, res) => res.json({}));
    t.mock.method(documentController, 'getDocuments', (req, res) => res.json({ user: req.user.preferred_username }));
    const headers = { ...GATEWAY, 'x-api-key': SUITE_KEY };

    assert.strictEqual((await call('/api/config', { headers })).status, 200);
    const read = await call('/api/documents', { headers });
    assert.strictEqual(read.status, 200);
    assert.strictEqual(JSON.parse(read.body).user, 'internal-service');
    const write = await call('/api/documents', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: { string: '{}' }
    });
    assert.strictEqual(write.status, 200);
  });

  // passiveAuth serves a rejected key as anonymous and /config has no guard, so only the gate
  // stops a junk key sent straight to APIM.
  await t.test('APIM plus a bogus or empty X-Api-Key is refused, even on public routes', async (t) => {
    let reached = 0;
    t.mock.method(documentController, 'getDocuments', (req, res) => { reached++; res.json({}); });

    for (const key of ['not-a-key', '']) {
      const headers = { ...GATEWAY, 'x-api-key': key };
      assert.strictEqual((await call('/api/config', { headers })).status, 403, `config, key '${key}'`);
      assert.strictEqual((await call('/api/documents', { headers })).status, 403, `documents, key '${key}'`);
    }
    assert.strictEqual(reached, 0);
  });

  await t.test('log serves a bogus key and writes one bad-key line', async (t) => {
    config.edgeGate = 'log';
    const warn = t.mock.method(logger, 'warn');

    const res = await call('/api/config', { headers: { ...GATEWAY, 'x-api-key': 'not-a-key' } });

    assert.strictEqual(res.status, 200);
    const lines = gateWarnings(warn);
    assert.strictEqual(lines.length, 1);
    assert.deepStrictEqual(lines[0].arguments[1], { evt: 'edge-gate', path: '/api/config', reason: 'bad-key' });
  });

  await t.test('/health/db is served with no headers at all', async (t) => {
    t.mock.method(healthController, 'db', (req, res) => res.json({ ok: true }));
    const res = await call('/health/db');
    assert.strictEqual(res.status, 200);
  });

  await t.test('the /api/health aliases are served with no headers at all', async (t) => {
    t.mock.method(searchSchemaController, 'searchSchema', (req, res) => res.json({ ok: true }));
    assert.strictEqual((await call('/api/health')).status, 200);
    assert.strictEqual((await call('/api/health/search-schema')).status, 200);
  });

  await t.test('log serves the request and writes exactly one gate line', async (t) => {
    config.edgeGate = 'log';
    const warn = t.mock.method(logger, 'warn');

    const res = await call('/api/config', { headers: { ...GATEWAY } });

    assert.strictEqual(res.status, 200);
    const lines = gateWarnings(warn);
    assert.strictEqual(lines.length, 1);
    assert.deepStrictEqual(lines[0].arguments[1], { evt: 'edge-gate', path: '/api/config', reason: 'no-edge' });
  });

  await t.test('log names a missing gateway hop and never logs header values', async (t) => {
    config.edgeGate = 'log';
    const warn = t.mock.method(logger, 'warn');

    await call('/api/config', { headers: { ...EDGE } });

    const lines = gateWarnings(warn);
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].arguments[1].reason, 'no-gateway');
    assert.ok(!JSON.stringify(lines[0].arguments).includes(EDGE['x-edge-secret']));
  });

  await t.test('log stays quiet for a request that came through the edge', async (t) => {
    config.edgeGate = 'log';
    const warn = t.mock.method(logger, 'warn');
    await call('/api/config', { headers: { ...GATEWAY, ...EDGE } });
    assert.strictEqual(gateWarnings(warn).length, 0);
  });

  await t.test('off serves everything and logs nothing', async (t) => {
    config.edgeGate = '';
    const warn = t.mock.method(logger, 'warn');
    const res = await call('/api/config');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(gateWarnings(warn).length, 0);
  });
});
