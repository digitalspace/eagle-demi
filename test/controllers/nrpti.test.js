'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const config = require('../../src/config');
const cosmos = require('../../src/db/cosmos-nosql');
const apiKeys = require('../../src/repositories/api-keys');
const { generateKey } = require('../../src/helpers/api-key');
const { forgetCachedKey } = require('../../src/helpers/auth');
const { withServer } = require('../helpers/with-server');

const EAGLE_ID = '5c1a2b3c4d5e6f7a8b9c0d1e';
const PROJECTS = {
  P: { id: 'P', eagleId: EAGLE_ID, read: ['public'] },
  hidden: { id: 'hidden', read: ['eao'] }
};
const ROWS = {
  mines: [{ id: 'g1:P', projectId: 'P', name: 'Red Chris', read: ['public'] }],
  regulatoryRecords: [{
    id: 'nrpti-1', projectId: 'P', kind: 'order', title: 'Order 1', issuedTo: 'A Person',
    source: { system: 'nrpti', upstream: 'bcmi', id: '1' }, read: ['public']
  }]
};

/** Stored projects and NRPTI rows; records the project id each NRPTI list was asked for. */
function stubStore(t, { sources = ['wildfire', 'nrpti'] } = {}) {
  const held = config.enrichmentSources;
  config.enrichmentSources = sources;
  t.after(() => { config.enrichmentSources = held; });

  const listedFor = [];
  t.mock.method(cosmos, 'readItem', async (container, id) => (container === 'projects' ? PROJECTS[id] || null : null));
  t.mock.method(cosmos, 'query', async (container, spec) => {
    const param = name => (spec.parameters.find(p => p.name === name) || {}).value;
    if (container === 'projects') return { items: Object.values(PROJECTS).filter(p => p.eagleId === param('@eagleId')) };
    // Key auth runs its own lookups; only the NRPTI lists are recorded.
    if (!ROWS[container]) return { items: [] };
    listedFor.push(param('@projectId'));
    return { items: ROWS[container].filter(row => row.projectId === param('@projectId')) };
  });
  return { listedFor };
}

async function get(path, headers = {}) {
  let result;
  await withServer(async (call) => {
    const res = await call(`/api${path}`, { headers });
    result = { status: res.status, body: await res.json() };
  });
  return result;
}

test('GET /projects/:id/mines is 404 while ENRICHMENT_SOURCES does not list nrpti', async (t) => {
  const { listedFor } = stubStore(t, { sources: ['wildfire'] });

  const res = await get('/projects/P/mines');

  assert.strictEqual(res.status, 404);
  assert.deepStrictEqual(listedFor, []);
});

test('GET /projects/:id/regulatory-records is 404 for a project the caller cannot read', async (t) => {
  const { listedFor } = stubStore(t);

  const res = await get('/projects/hidden/regulatory-records');

  assert.strictEqual(res.status, 404);
  assert.deepStrictEqual(listedFor, []);
});

test('GET /projects/:id/mines is 404 for a key scoped to another project', async (t) => {
  const { listedFor } = stubStore(t);
  const { keyId, plaintext, hash } = generateKey(config.environmentName);
  forgetCachedKey(keyId);
  t.after(() => forgetCachedKey(keyId));
  t.mock.method(apiKeys, 'getById', async () => ({
    id: keyId, name: 'scoped-to-q', hash, roles: ['public'], projectScope: ['Q'], expiresAt: null, revokedAt: null
  }));
  t.mock.method(apiKeys, 'touchLastUsed', async () => {});

  const res = await get('/projects/P/mines', { 'X-Api-Key': plaintext });

  assert.strictEqual(res.status, 404);
  assert.deepStrictEqual(listedFor, []);
});

test('GET /projects/:id/mines with the Eagle id lists the same rows as the DEMI id', async (t) => {
  const { listedFor } = stubStore(t);

  const byDemiId = await get('/projects/P/mines');
  const byEagleId = await get(`/projects/${EAGLE_ID}/mines`);

  assert.deepStrictEqual(listedFor, ['P', 'P']);
  assert.deepStrictEqual(byEagleId.body, byDemiId.body);
  assert.deepStrictEqual(byDemiId.body.map(row => row.name), ['Red Chris']);
});

test('GET /projects/:id/regulatory-records anonymous leaves out issuedTo, source and read', async (t) => {
  stubStore(t);

  const res = await get('/projects/P/regulatory-records');

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body[0].title, 'Order 1');
  assert.deepStrictEqual(['issuedTo', 'source', 'read'].filter(field => field in res.body[0]), []);
});
