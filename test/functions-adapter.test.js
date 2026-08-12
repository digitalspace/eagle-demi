'use strict';

/**
 * The Azure Functions adapter behaves like an http.Server where it matters.
 *
 * This exists because of a defect that survived every other test in this repo: `api/index.js`
 * fabricates `res` as a bare EventEmitter, and its `end()` resolved the host's promise without ever
 * emitting 'finish'. `middleware/http-logger.js` does all of its work in a `res.on('finish')`
 * handler, so the per-request access log — the only record of a caller's identity, IP and latency —
 * never ran in Azure. It ran perfectly under `yarn start`, on a genuine ServerResponse that emits
 * 'finish' by itself, which is exactly why nothing caught it: the code was exercised everywhere
 * except where it shipped.
 *
 * The assertions below are on the OBSERVABLE consequence — a log record with the request's fields —
 * rather than on the emit itself, so they keep holding if the adapter is rewritten.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { logger } = require('../src/utils/logger');
const { handleExpress } = require('../api/index');

/** The shape @azure/functions hands a handler: a Request-like object with async body accessors. */
function functionsRequest(method, url, headers = {}) {
  return {
    method,
    url,
    headers: new Map(Object.entries(headers)),
    arrayBuffer: async () => new ArrayBuffer(0)
  };
}

/** Capture winston records without writing them, and without touching transports. */
function captureLogs(t) {
  const records = [];
  for (const level of ['info', 'warn', 'error']) {
    t.mock.method(logger, level, (message, meta) => {
      records.push({ level, message, ...(meta || {}) });
    });
  }
  return records;
}

test('functions adapter', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a served request produces a request log', async () => {
    const records = captureLogs(t);

    const result = await handleExpress(
      functionsRequest('GET', 'https://demi-api-test.azurewebsites.net/api/health'),
      null
    );

    assert.strictEqual(result.status, 200, 'the request is served');

    // The load-bearing assertion. Before the fix this array held nothing at all, because the
    // 'finish' handler never ran — so this test fails on the original code and passes on the fixed
    // code, which is the whole point of writing it.
    const request = records.find(r => r.evt === 'request');
    assert.ok(request, "a 'request' event is emitted for every served request");
    assert.strictEqual(request.method, 'GET');
    assert.strictEqual(request.path, '/api/health');
    assert.strictEqual(request.status, 200);
    assert.strictEqual(request.principal, 'anonymous',
      'an absent identity is recorded as absent, never left blank');
  });

  await t.test('the path is logged without its query string', async () => {
    const records = captureLogs(t);

    await handleExpress(
      functionsRequest('GET', 'https://demi-api-test.azurewebsites.net/api/health?foo=bar&baz=1'),
      null
    );

    const request = records.find(r => r.evt === 'request');
    assert.strictEqual(request.path, '/api/health',
      'grouping on the full URL would scatter every search across as many buckets as search terms');
  });

  await t.test('a request is logged exactly once', async () => {
    const records = captureLogs(t);

    await handleExpress(
      functionsRequest('GET', 'https://demi-api-test.azurewebsites.net/api/health'),
      null
    );

    // A real ServerResponse ignores a second end() and emits 'finish' once. Without that guard a
    // double-end would double-count every request, and a usage dashboard built on these rows would
    // be wrong in a way nobody would notice.
    assert.strictEqual(records.filter(r => r.evt === 'request').length, 1);
  });

  await t.test('a 404 is still counted, with its status', async () => {
    const records = captureLogs(t);

    const result = await handleExpress(
      functionsRequest('GET', 'https://demi-api-test.azurewebsites.net/api/nope'),
      null
    );

    assert.strictEqual(result.status, 404);

    // Warn level, not info — but `evt` is set on every branch of the middleware, so error responses
    // land in the same dashboard panel as successful ones. A usage report that silently dropped
    // failures would overstate how well the API is working.
    const request = records.find(r => r.evt === 'request');
    assert.ok(request, 'failed requests are recorded too');
    assert.strictEqual(request.status, 404);
    assert.strictEqual(request.level, 'warn');
  });
});
