'use strict';

// `/api-docs` must not exist in prod.
//
// The Swagger UI is unauthenticated and the spec it renders names every route, parameter and
// role in the system. `src/config.js` reads ENVIRONMENT once at require time, so this has to be
// set before anything else loads — which is why the prod case lives in its own file. `node --test`
// runs each file in its own process, and the non-prod half is in test/app.boot.test.js.
process.env.ENVIRONMENT = 'prod';
// src/config.js refuses to boot test or prod on an empty DEMI_ALLOWED_CLIENTS.
process.env.DEMI_ALLOWED_CLIENTS = 'eagle-admin-console';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const config = require('../src/config');
const app = require('../src/app');

test('config picked up the prod environment', () => {
  // If this ever fails the 404 below proves nothing — it would be asserting the path is absent
  // in whatever environment the test process actually resolved to.
  assert.strictEqual(config.environmentName, 'prod');
});

test('/api-docs 404s in prod', async () => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const p of ['/api-docs', '/api-docs/', '/api-docs/swagger-ui.css']) {
      const res = await fetch(`${base}${p}`, { signal: AbortSignal.timeout(10000) });
      assert.strictEqual(res.status, 404, `${p} should 404 in prod`);
      assert.deepStrictEqual(await res.json(), { error: 'Endpoint not found.' },
        `${p} should fall through to the normal 404, not to a Swagger asset`);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
