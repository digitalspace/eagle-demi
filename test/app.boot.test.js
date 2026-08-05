'use strict';

// The Express app has to actually BOOT and route.
//
// Every other test in `test/` calls controllers and helpers directly, so none of them
// loads `src/app.js` or exercises the router. That gap is why a green suite said nothing
// when Dependabot proposed express 4.22.2 -> 5.2.1 (PR #35, closed): Express 5 ships
// path-to-regexp v8, where a route pattern that used to be legal now THROWS AT MOUNT
// TIME. The whole app fails to load and no handler test notices.
//
// So this asserts three things a router change breaks and a unit test cannot see:
// mounting `src/app.js` does not throw, a real request reaches a real handler, and the
// 404 fallback still runs. It deliberately uses `node:http` and global `fetch` rather
// than supertest — no new dependency for what fifteen lines already do.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

async function withServer(fn) {
  const app = require('../src/app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('src/app.js mounts without throwing', () => {
  // A path-to-regexp rejection surfaces here, on require, not on the request.
  const app = require('../src/app');
  assert.strictEqual(typeof app, 'function', 'app should be an Express request handler');
});

test('a request reaches a real handler', async () => {
  await withServer(async (base) => {
    // `/api/config` is the unauthenticated route, so this needs no token and no database.
    const res = await fetch(`${base}/api/config`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('application/json'));
  });
});

test('the 404 fallback still runs', async () => {
  await withServer(async (base) => {
    // Proves the terminal middleware is reached rather than the request hanging or
    // Express returning its own default HTML error page.
    const res = await fetch(`${base}/api/there-is-no-such-route`);
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(await res.json(), { error: 'Endpoint not found.' });
  });
});
