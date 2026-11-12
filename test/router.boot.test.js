'use strict';

// The route table compiles at module load and routes: requiring the router does not throw, a real
// request reaches a real handler, and the 404 fallback runs. No other test loads the router.

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
  // The timeout is the assertion: a stale local `public/` build would pass a plain status check.
  // `/search` is not listed because the API owns that path.
  await withServer(async (call) => {
    for (const p of ['/map', '/intake']) {
      const res = await call(p);
      assert.strictEqual(res.status, 404, `${p} should 404`);
      assert.deepStrictEqual(await res.json(), { error: 'Endpoint not found.' });
    }
  });
});

test('every request is logged', async (t) => {
  // The access log is the only record of a caller's identity, IP and latency; asserted on the
  // log record itself, not on where the call is made.
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
  // ENVIRONMENT is unset, so environmentName is 'dev'. The prod half is
  // test/router.api-docs-prod.test.js.
  assert.notStrictEqual(process.env.ENVIRONMENT, 'prod', 'this test is only meaningful outside prod');
  await withServer(async (call) => {
    const res = await call('/api-docs');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /yaml/);
    assert.match(await res.text(), /^openapi:/);
  });
});

test('the continuation token is exposed to cross-origin callers', async () => {
  // Without the expose header the browser hides `x-continuation-token`, and paging stops at page one.
  await withServer(async (call) => {
    const res = await call('/api/config', { headers: { Origin: 'http://localhost:4200' } });
    const exposed = (res.headers.get('access-control-expose-headers') || '')
      .split(',').map(h => h.trim().toLowerCase());
    assert.ok(exposed.includes('x-continuation-token'),
      `expected x-continuation-token to be exposed, got: ${exposed.join(', ') || '(none)'}`);
  });
});

test('an unset CORS_ORIGIN allows no deployed origin', async () => {
  // The fallback fails closed: the AFD hostname carries a deploy-time hash, so it only arrives via
  // CORS_ORIGIN. Guards against an edit adding a wildcard or a guessed hostname.
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
