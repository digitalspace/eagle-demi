'use strict';

// The comma-separated CORS_ORIGIN allowlist, the branch every deployed environment runs. Its own
// file because router.js reads CORS_ORIGIN at load; "refused" means no Allow-Origin header.

const test = require('node:test');
const assert = require('node:assert');
const { HttpRequest } = require('@azure/functions');

// Drops only router.js from the cache per case; its children stay cached, so nothing reconnects
// and no second timer starts.
async function withRouter(corsOrigin, fn) {
  process.env.CORS_ORIGIN = corsOrigin;
  delete require.cache[require.resolve('../src/http/router')];
  const { dispatch } = require('../src/http/router');
  try {
    await fn(dispatch);
  } finally {
    delete process.env.CORS_ORIGIN;
    delete require.cache[require.resolve('../src/http/router')];
  }
}

// `/api/config` is the unauthenticated route, so this needs no token and no database.
async function allowOriginFor(dispatch, origin) {
  const res = await dispatch(new HttpRequest({
    method: 'GET',
    url: 'http://127.0.0.1/api/config',
    headers: origin ? { Origin: origin } : {}
  }), { error: () => {} });
  assert.strictEqual(res.status, 200, 'the request itself is always served');
  return res.headers['access-control-allow-origin'] ?? null;
}

const FRONT_DOOR = 'https://demi-frontend-test-eaa9cyfydsb0ejet.a02.azurefd.net';
// A second origin, because the code under test is a LIST parser and one entry exercises none of it.
// The cases below are about parsing — any two real origins will do.
const LOCAL_DEV = 'http://localhost:4200';

test('every origin in a comma-separated CORS_ORIGIN is allowed', async () => {
  // A parser that took only the first entry would silently drop every origin after it, which is
  // exactly how a second frontend ends up CORS-blocked with nothing in the deploy to show for it.
  await withRouter(`${FRONT_DOOR},${LOCAL_DEV}`, async (dispatch) => {
    assert.strictEqual(await allowOriginFor(dispatch, FRONT_DOOR), FRONT_DOOR);
    assert.strictEqual(await allowOriginFor(dispatch, LOCAL_DEV), LOCAL_DEV);
  });
});

test('whitespace around the separator is tolerated', async () => {
  // App settings get edited by hand in the portal, where a space after the comma is the natural way
  // to type a list. Without the .trim() the second entry becomes ' https://…' and matches nothing.
  await withRouter(`${FRONT_DOOR} ,  ${LOCAL_DEV} `, async (dispatch) => {
    assert.strictEqual(await allowOriginFor(dispatch, FRONT_DOOR), FRONT_DOOR);
    assert.strictEqual(await allowOriginFor(dispatch, LOCAL_DEV), LOCAL_DEV);
  });
});

test('an origin outside the list is refused', async () => {
  await withRouter(FRONT_DOOR, async (dispatch) => {
    assert.strictEqual(await allowOriginFor(dispatch, 'https://evil.example'), null,
      'an unlisted origin must not be reflected back');
  });
});

test('CORS_ORIGIN of "*" allows any origin', async () => {
  await withRouter('*', async (dispatch) => {
    assert.strictEqual(await allowOriginFor(dispatch, 'https://anything.example'), 'https://anything.example');
  });
});

test('a request with no Origin header is allowed', async () => {
  // Non-browser callers (indexer, health probes, curl) send no Origin and must pass through.
  await withRouter(FRONT_DOOR, async (dispatch) => {
    assert.strictEqual(await allowOriginFor(dispatch, null), null,
      'nothing to reflect, and nothing to block');
  });
});
