'use strict';

// The route table has to actually COMPILE and route.
//
// Every other test in `test/` calls controllers and helpers directly, so none of them loads
// `src/http/router.js` or exercises the matcher. That gap is why a green suite said nothing when
// Dependabot proposed express 4.22.2 -> 5.2.1 (PR #35, closed): a route pattern that used to be
// legal started throwing AT MOUNT TIME, the whole app failed to load, and no handler test noticed.
// Express is gone, but the shape of the failure is not — src/http/router.js compiles every route
// regex at module load, so a bad pattern still fails on require rather than on the request.
//
// So this asserts what a routing change breaks and a unit test cannot see: requiring the router
// does not throw, a real request reaches a real handler, and the 404 fallback still runs.

const test = require('node:test');
const assert = require('node:assert');

const { logger } = require('../src/utils/logger');
const { withServer } = require('./helpers/with-server');

test('the route table compiles without throwing', () => {
  // A bad `:param` pattern surfaces here, on require, not on the request.
  const { dispatch } = require('../src/http/router');
  assert.strictEqual(typeof dispatch, 'function', 'the router should export a dispatch handler');
});

test('a request reaches a real handler', async () => {
  await withServer(async (call) => {
    // `/api/config` is the unauthenticated route, so this needs no token and no database.
    const res = await call('/api/config');
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('application/json'));
  });
});

test('the root mount answers the same route', async () => {
  // rproxy serves this API at both `/api` and `/`, which the old app got from mounting one router
  // twice. Now it is one leading-`/api` strip, so the two forms can only diverge by accident.
  await withServer(async (call) => {
    for (const p of ['/health', '/api/health']) {
      const res = await call(p);
      assert.strictEqual(res.status, 200, `${p} should answer`);
      assert.deepStrictEqual(await res.json(), { status: 'ok' });
    }
  });
});

test('the 404 fallback still runs', async () => {
  await withServer(async (call) => {
    const res = await call('/api/there-is-no-such-route');
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(await res.json(), { error: 'Endpoint not found.' });
  });
});

test('the old SPA paths 404 rather than hanging', async () => {
  // `/map`, `/search` and `/intake` used to `res.sendFile('../public/index.html')`. That file is
  // untracked, so in Azure it was never there, and the request hung for the platform's full 240 s.
  //
  // The timeout is the assertion. A plain status check would pass against the old code on any
  // machine that happens to have a stale local build in `public/`.
  //
  // `/search` is deliberately not in this list: the API owns that path.
  await withServer(async (call) => {
    for (const p of ['/map', '/intake']) {
      const res = await call(p);
      assert.strictEqual(res.status, 404, `${p} should 404`);
      assert.deepStrictEqual(await res.json(), { error: 'Endpoint not found.' });
    }
  });
});

test('every request is logged', async (t) => {
  // The per-request access log is the only record of a caller's identity, IP and latency, and it
  // has been lost once already: it lived in a `res.on('finish')` handler, and the old adapter's
  // fake `res` never emitted 'finish'. It ran perfectly under `yarn start` and never in Azure.
  // Asserted on the observable log record rather than on where the call is made from.
  const lines = [];
  t.mock.method(logger, 'info', (message, meta) => { lines.push({ message, meta }); });

  await withServer(async (call) => {
    await call('/api/config');
  });

  const line = lines.find(l => l.meta && l.meta.evt === 'request');
  assert.ok(line, 'a served request must produce a request log record');
  assert.strictEqual(line.meta.path, '/api/config');
  assert.strictEqual(line.meta.status, 200);
  assert.strictEqual(line.meta.principal, 'anonymous');
});

test('/api-docs serves the spec outside prod', async () => {
  // ENVIRONMENT is unset here, so config.environmentName is 'dev' and the route is in the table.
  // The prod half of this gate needs the variable set before src/config.js loads, which is a
  // different process — test/router.api-docs-prod.test.js.
  assert.notStrictEqual(process.env.ENVIRONMENT, 'prod', 'this test is only meaningful outside prod');
  await withServer(async (call) => {
    const res = await call('/api-docs');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /yaml/);
    assert.match(await res.text(), /^openapi:/);
  });
});

test('the continuation token is exposed to cross-origin callers', async () => {
  // `x-continuation-token` is how a client asks for the next page, and without this header the
  // browser strips it from the response before the frontend ever sees it — paging stops at page
  // one with a 200 and nothing to show for it.
  await withServer(async (call) => {
    const res = await call('/api/config', { headers: { Origin: 'http://localhost:4200' } });
    const exposed = (res.headers.get('access-control-expose-headers') || '')
      .split(',').map(h => h.trim().toLowerCase());
    assert.ok(exposed.includes('x-continuation-token'),
      `expected x-continuation-token to be exposed, got: ${exposed.join(', ') || '(none)'}`);
  });
});

test('an unset CORS_ORIGIN allows no deployed origin', async () => {
  // The default allowlist used to name the three demi-frontend App Services. Those are gone: the
  // frontend is a Storage static website behind Front Door, and an AFD endpoint hostname carries a
  // hash assigned at deploy time, so it can only arrive via CORS_ORIGIN. That makes the fallback
  // fail CLOSED, and this pins it — the failure mode being guarded against is a future edit
  // "restoring" a wildcard or a guessed hostname, which no other test would notice.
  assert.strictEqual(process.env.CORS_ORIGIN, undefined, 'this test is only meaningful unset');
  await withServer(async (call) => {
    const denied = await call('/api/config', { headers: { Origin: 'https://evil.example' } });
    assert.strictEqual(denied.headers.get('access-control-allow-origin'), null,
      'an unknown origin must not be reflected back');

    const allowed = await call('/api/config', { headers: { Origin: 'http://localhost:4200' } });
    assert.strictEqual(allowed.headers.get('access-control-allow-origin'), 'http://localhost:4200',
      'the local dev server is the one origin the fallback keeps');
  });
});

test('the frozen security headers are still sent', async () => {
  // helmet is gone; its output is a constant now. CSP stays OFF because
  // src/controllers/nosql/link.js serves HTML written for its absence.
  await withServer(async (call) => {
    const res = await call('/api/config');
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.strictEqual(res.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
    assert.strictEqual(res.headers.get('content-security-policy'), null);
  });
});
