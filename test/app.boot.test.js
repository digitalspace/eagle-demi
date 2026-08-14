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

test('the old SPA paths 404 rather than hanging', async () => {
  // `/map`, `/search` and `/intake` used to `res.sendFile('../public/index.html')`. That file is
  // untracked, so in Azure it was never there — and under the Functions adapter, whose fake `res`
  // resolves only inside `res.end`, the missing-file path in `send` never reaches it. Measured on
  // dev 2026-08-06: GET /map returned no response for 90 s, and the platform holds it for 240.
  //
  // The timeout is the assertion. A plain status check would pass against the old code on any
  // machine that happens to have a stale local build in `public/`, which is precisely how this
  // survived unnoticed.
  //
  // `/search` is deliberately not in this list: `app.use('/', apiRoutes)` mounts the API at the
  // root as well, so the search endpoint always shadowed the SPA route of the same name. The
  // deleted route array claimed a path the API already owned.
  await withServer(async (base) => {
    for (const p of ['/map', '/intake']) {
      const res = await fetch(`${base}${p}`, { signal: AbortSignal.timeout(5000) });
      assert.strictEqual(res.status, 404, `${p} should 404`);
      assert.deepStrictEqual(await res.json(), { error: 'Endpoint not found.' });
    }
  });
});

test('an unset CORS_ORIGIN allows no deployed origin', async () => {
  // The default allowlist used to name the three demi-frontend App Services. Those are gone: the
  // frontend is a Storage static website behind Front Door, and an AFD endpoint hostname carries a
  // hash assigned at deploy time, so it can only arrive via CORS_ORIGIN. That makes the fallback
  // fail CLOSED, and this pins it — the failure mode being guarded against is a future edit
  // "restoring" a wildcard or a guessed hostname, which no other test would notice.
  //
  // CORS_ORIGIN is unset in this process (src/app.js does not load dotenv; only src/server.js
  // does), so the app under test is running exactly that fallback.
  assert.strictEqual(process.env.CORS_ORIGIN, undefined, 'this test is only meaningful unset');
  await withServer(async (base) => {
    const denied = await fetch(`${base}/api/config`, { headers: { Origin: 'https://evil.example' } });
    assert.strictEqual(denied.headers.get('access-control-allow-origin'), null,
      'an unknown origin must not be reflected back');

    const allowed = await fetch(`${base}/api/config`, { headers: { Origin: 'http://localhost:4200' } });
    assert.strictEqual(allowed.headers.get('access-control-allow-origin'), 'http://localhost:4200',
      'the local dev server is the one origin the fallback keeps');
  });
});
