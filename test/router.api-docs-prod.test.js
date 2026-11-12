'use strict';

// `/api-docs` must not exist in prod: the spec names every route and role, unauthenticated. Own
// file because src/config.js reads ENVIRONMENT once at require time.
process.env.ENVIRONMENT = 'prod';
// src/config.js refuses to boot test or prod on an empty DEMI_ALLOWED_CLIENTS.
process.env.DEMI_ALLOWED_CLIENTS = 'eagle-admin-console';

const test = require('node:test');
const assert = require('node:assert');

const config = require('../src/config');
const { withServer } = require('./helpers/with-server');

test('config picked up the prod environment', () => {
  // If this ever fails the 404 below proves nothing — it would be asserting the path is absent
  // in whatever environment the test process actually resolved to.
  assert.strictEqual(config.environmentName, 'prod');
});

test('/api-docs 404s in prod', async () => {
  await withServer(async (call) => {
    for (const p of ['/api-docs', '/api-docs/', '/api/api-docs']) {
      const res = await call(p);
      assert.strictEqual(res.status, 404, `${p} should 404 in prod`);
      assert.deepStrictEqual(await res.json(), { error: 'Endpoint not found.' },
        `${p} should fall through to the normal 404, not to the spec`);
    }
  });
});
