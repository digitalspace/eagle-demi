'use strict';

// The comma-separated CORS_ORIGIN allowlist — the branch every deployed environment runs.
//
// `test/app.boot.test.js` pins the UNSET fallback, which no deployed environment takes: Azure
// always sets CORS_ORIGIN (api-web-app.bicep passes the frontend host name through). So the parsing
// in `src/app.js` was the one part of this with no test at all, and a misconfiguration on exactly
// that path blocked every API call from the DEMI frontend for a period after the Front Door
// cutover — with a green suite and every header check passing.
//
// This is a sibling file rather than more cases in app.boot.test.js because `src/app.js` reads
// CORS_ORIGIN at MODULE LOAD, so a value can only be tested by a module instance that has not been
// loaded yet, and `node --test` gives each file its own process.
//
// What a CORS decision looks like from outside: the request is always served. `cors` never rejects,
// it only decides whether to echo `Access-Control-Allow-Origin` back — so "refused" means the
// header is absent and the browser, not the server, drops the response.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

// Same shape as the helper in test/app.boot.test.js, with the env var folded in: each CORS_ORIGIN
// value needs its own instance of `src/app.js`, so that one module is dropped from the cache before
// every server. Its children (Cosmos client, rate limiter) stay cached, so nothing reconnects and
// no second timer starts.
async function withServer(corsOrigin, fn) {
  process.env.CORS_ORIGIN = corsOrigin;
  delete require.cache[require.resolve('../src/app')];
  const app = require('../src/app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.CORS_ORIGIN;
  }
}

// `/api/config` is the unauthenticated route, so this needs no token and no database.
async function allowOriginFor(base, origin) {
  const res = await fetch(`${base}/api/config`, origin ? { headers: { Origin: origin } } : undefined);
  assert.strictEqual(res.status, 200, 'the request itself is always served');
  return res.headers.get('access-control-allow-origin');
}

const FRONT_DOOR = 'https://demi-frontend-test-eaa9cyfydsb0ejet.a02.azurefd.net';
// A second origin, because the code under test is a LIST parser and one entry exercises none of it.
// This used to be the old App Service kept as the cutover's rollback target; that app was deleted at
// step 10, so it is the local dev origin now. The cases below are about parsing, not about these two
// hosts specifically — any two real origins will do.
const LOCAL_DEV = 'http://localhost:4200';

test('every origin in a comma-separated CORS_ORIGIN is allowed', async () => {
  // A parser that took only the first entry would silently drop every origin after it, which is
  // exactly how a second frontend ends up CORS-blocked with nothing in the deploy to show for it.
  await withServer(`${FRONT_DOOR},${LOCAL_DEV}`, async (base) => {
    assert.strictEqual(await allowOriginFor(base, FRONT_DOOR), FRONT_DOOR);
    assert.strictEqual(await allowOriginFor(base, LOCAL_DEV), LOCAL_DEV);
  });
});

test('whitespace around the separator is tolerated', async () => {
  // App settings get edited by hand in the portal, where a space after the comma is the natural way
  // to type a list. Without the .trim() the second entry becomes ' https://…' and matches nothing.
  await withServer(`${FRONT_DOOR} ,  ${LOCAL_DEV} `, async (base) => {
    assert.strictEqual(await allowOriginFor(base, FRONT_DOOR), FRONT_DOOR);
    assert.strictEqual(await allowOriginFor(base, LOCAL_DEV), LOCAL_DEV);
  });
});

test('an origin outside the list is refused', async () => {
  await withServer(FRONT_DOOR, async (base) => {
    assert.strictEqual(await allowOriginFor(base, 'https://evil.example'), null,
      'an unlisted origin must not be reflected back');
  });
});

test('CORS_ORIGIN of "*" allows any origin', async () => {
  await withServer('*', async (base) => {
    assert.strictEqual(await allowOriginFor(base, 'https://anything.example'), 'https://anything.example');
  });
});

test('a request with no Origin header is allowed', async () => {
  // Non-browser callers — the indexer, health probes, curl — send no Origin. They must pass
  // through: rejecting them turns the origin callback's error into a 500 on every server-to-server
  // call, which no browser-facing test would notice.
  await withServer(FRONT_DOOR, async (base) => {
    assert.strictEqual(await allowOriginFor(base, null), null,
      'nothing to reflect, and nothing to block');
  });
});
