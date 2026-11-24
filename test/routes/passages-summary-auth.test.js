'use strict';

// GET /api/documents/passages/summary through the real route table: privileged only, like
// /api/search/summary, and it must reach `summarize` rather than a `/documents/:id` route.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const { useConfig } = require('../helpers/use-config');
const summary = require('../../src/controllers/search/summary');
const { withServer } = require('../helpers/with-server');

const PATH = '/api/documents/passages/summary?q=water&fuzzy=true';

function bearer(t, roles) {
  useConfig(t, { keycloakEnabled: false });
  const token = jwt.sign({ preferred_username: 'suite-user', realm_access: { roles } }, 'suite-only');
  return { authorization: `Bearer ${token}` };
}

async function callSummary(t, headers) {
  const seen = [];
  t.mock.method(summary, 'summarize', (req, res) => { seen.push(req.query); res.json({ summary: 'ok' }); });
  let status;
  await withServer(async (call) => { status = (await call(PATH, { headers })).status; });
  return { status, seen };
}

test('passages summary route', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('no token is 401 and never reaches summarize', async (t) => {
    const { status, seen } = await callSummary(t, {});
    assert.equal(status, 401);
    assert.deepEqual(seen, []);
  });

  await t.test('a login without a session role is 403', async (t) => {
    const { status, seen } = await callSummary(t, bearer(t, ['public']));
    assert.equal(status, 403);
    assert.deepEqual(seen, []);
  });

  await t.test('a staff token reaches summarize with q and fuzzy', async (t) => {
    const { status, seen } = await callSummary(t, bearer(t, ['staff']));
    assert.equal(status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].q, 'water');
    assert.equal(seen[0].fuzzy, 'true');
  });
});
