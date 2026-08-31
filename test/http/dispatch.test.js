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
const { HttpRequest } = require('@azure/functions');

const { dispatch } = require('../../src/http/router');
const configController = require('../../src/controllers/config');
const documentController = require('../../src/controllers/nosql/document');
const links = require('../../src/repositories/links');

/** The suite credential src/helpers/auth.js honours only under NODE_ENV=test. */
const AUTHED = { 'x-api-key': 'eagle-demi-api-key' };

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
