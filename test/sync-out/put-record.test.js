'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const config = require('../../src/config');
const { logger } = require('../../src/utils/logger');
const eagle = require('../../src/sync-out/eagle');
const { putRecord } = require('../../src/sync-out/_put');
const { API, wireEagle } = require('../helpers/sync-out-eagle');

const S = { apiBase: API, issuer: config.keycloakIssuer, clientId: 'demi-sync-out', clientSecret: 'unused' };

test('putRecord logs the PUT with the caller log fields', async (t) => {
  eagle.clearToken();
  const calls = wireEagle(t, { 'PUT /update/e1': { status: 200 } });
  const logged = [];
  t.mock.method(logger, 'info', (message, meta) => { logged.push({ message, meta }); });

  assert.strictEqual(await putRecord(S, '/update/e1', { a: 1 }, { id: 'r1', kind: 'update' }), true);

  assert.deepStrictEqual(calls, [{ key: 'PUT /update/e1', body: { a: 1 } }]);
  const line = logged.find(l => l.message.includes('PUT /update/e1'));
  assert.ok(line, 'the PUT is logged');
  assert.strictEqual(line.meta.id, 'r1');
  assert.strictEqual(line.meta.kind, 'update');
});
