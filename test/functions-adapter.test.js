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
const { handleExpress, queryFrom } = require('../api/index');

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

// REPEATED QUERY KEYS. `Object.fromEntries(searchParams.entries())` kept only the LAST occurrence,
// and eagle-public repeats a key per selected option (`api.ts:186-196`) — so every multi-select
// facet applied one option and answered 200. Measured live before the fix:
// `and[region]=Peace&and[region]=Cariboo` returned 13 against demi and 89 against prod
// eagle-search. Asserted on literal expected values rather than by re-parsing the URL, because a
// test that rebuilds its expectation from the code under test passes either way.
test('a repeated query key arrives as an array, not as its last value', () => {
  const query = queryFrom(new URLSearchParams(
    'dataset=Project&and[region]=Peace&and[region]=Cariboo&and[region]=Skeena&pageSize=10'));

  // THREE values, not two. With only two, the "append to the existing array" path is never
  // exercised — a build that keeps the first two and drops the rest stays green on a pair.
  assert.deepStrictEqual(query['and[region]'], ['Peace', 'Cariboo', 'Skeena']);
  assert.strictEqual(query.dataset, 'Project');
  assert.strictEqual(query.pageSize, '10', 'a key that appears once stays a string');
});

// THE CALL SITE, not just the helper. `queryFrom` can be perfect and unused: reverting
// `api/index.js` to `Object.fromEntries(...)` left every other test in this file green, because
// they all call the helper directly. This drives a real request through the adapter and reads what
// the Express app was actually handed.
test('the adapter hands the app the array, not the last value', async (t) => {
  const appPath = require.resolve('../src/app');
  const cached = require.cache[appPath];
  let seen = null;

  require.cache[appPath] = {
    id: appPath,
    filename: appPath,
    loaded: true,
    exports: (req, res) => {
      seen = req.query;
      res.statusCode = 200;
      res.end('ok');
    }
  };
  t.after(() => { require.cache[appPath] = cached; });

  const result = await handleExpress(functionsRequest(
    'GET',
    'https://demi-api-test.azurewebsites.net/api/search' +
      '?dataset=Project&and[region]=Peace&and[region]=Cariboo&sortBy=-name&sortBy='
  ), null);

  assert.strictEqual(result.status, 200, 'the stubbed app answered, so a query was built');
  assert.deepStrictEqual(seen['and[region]'], ['Peace', 'Cariboo']);
  assert.deepStrictEqual(seen.sortBy, ['-name', '']);
});

// The same collapse ate SORTING, and it is a different symptom of one bug: `api.ts:176-177`
// appends `sortBy` twice with the second routinely empty, so `sortBy=-name&sortBy=` arrived as ''
// — no sort asked for, which also routed the request to the Cosmos list instead of the index.
test('the empty second sortBy no longer erases the first', () => {
  const query = queryFrom(new URLSearchParams('dataset=Project&sortBy=-name&sortBy='));
  assert.deepStrictEqual(query.sortBy, ['-name', '']);
});

// Order must not decide the answer. Before the fix `sortBy=&sortBy=-name` worked and
// `sortBy=-name&sortBy=` did not, which is what made the defect look like a frontend quirk.
test('a repeated key keeps every value whichever order they arrive in', () => {
  assert.deepStrictEqual(queryFrom(new URLSearchParams('sortBy=&sortBy=-name')).sortBy,
    ['', '-name']);
});

// A query key named like an Object.prototype member must be an ordinary own property, never a
// prototype read: on a normal object `constructor` is already "present" and `toString` is a
// function. `querystring.parse` returns a null-prototype object, which is why this holds.
test('a query key that collides with Object.prototype is still read correctly', () => {
  const query = queryFrom(new URLSearchParams('constructor=a&constructor=b&toString=c&__proto__=x'));
  assert.deepStrictEqual(query.constructor, ['a', 'b']);
  assert.strictEqual(query.toString, 'c');
  assert.strictEqual(query.__proto__, 'x');
  assert.strictEqual({}.x, undefined, 'and nothing was written to Object.prototype');
});

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
