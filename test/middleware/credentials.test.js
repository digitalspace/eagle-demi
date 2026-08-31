'use strict';

/**
 * The load that puts a caller's grants on the request.
 *
 * Three things can go wrong here and none of them is visible downstream: loading for the wrong
 * party, serving a stale grant past the cache TTL, and letting a Cosmos failure decide access.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const repo = require('../../src/repositories/credentials');
const {
  attachCredentials, partiesFor, forgetCachedParty, CREDENTIAL_CACHE_TTL_MS
} = require('../../src/middleware/credentials');

const IN_A_YEAR = new Date(Date.now() + 365 * 86400000).toISOString();

const live = (id, partyId) => ({
  id,
  party: { type: 'user', id: partyId },
  scope: { type: 'project', ids: ['207'] },
  levels: [2],
  start: new Date(Date.now() - 86400000).toISOString(),
  end: IN_A_YEAR,
  revokedAt: null
});

test('every identity the caller holds is a party', () => {
  assert.deepStrictEqual(
    partiesFor({ sub: 's1', keyId: 'k1', groups: ['g1', 'g2'] }),
    ['s1', 'k1', 'g1', 'g2']);
  assert.deepStrictEqual(partiesFor({ sub: 's1', groups: ['s1'] }), ['s1'], 'deduplicated');
  assert.deepStrictEqual(partiesFor(undefined), [], 'anonymous holds none');
});

test('an anonymous caller does no lookup at all', async (t) => {
  t.mock.method(repo, 'listForParty', async () => assert.fail('no party, no read'));

  const req = {};
  assert.deepStrictEqual(await attachCredentials(req), []);
  assert.deepStrictEqual(req.credentials, []);
  t.mock.restoreAll();
});

test('grants are loaded per party and cached for the TTL', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const asked = [];
  t.mock.method(repo, 'listForParty', async (partyId) => {
    asked.push(partyId);
    return [live(`c-${partyId}`, partyId)];
  });

  const user = { sub: 's1', groups: ['g1'] };
  const now = Date.now();

  const first = await attachCredentials({ user }, now);
  assert.deepStrictEqual(asked, ['s1', 'g1'], 'sub and every group');
  assert.deepStrictEqual(first.map(c => c.id), ['c-s1', 'c-g1']);

  await attachCredentials({ user }, now + CREDENTIAL_CACHE_TTL_MS - 1);
  assert.strictEqual(asked.length, 2, 'served from the cache inside the TTL');

  await attachCredentials({ user }, now + CREDENTIAL_CACHE_TTL_MS);
  assert.strictEqual(asked.length, 4, 'and re-read once it lapses — a revoke lands within the TTL');

  forgetCachedParty('s1');
  forgetCachedParty('g1');
});

test('revoked and out-of-window grants never reach the request', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  t.mock.method(repo, 'listForParty', async (partyId) => [
    live('c-live', partyId),
    { ...live('c-revoked', partyId), revokedAt: new Date().toISOString() },
    { ...live('c-expired', partyId), end: new Date(Date.now() - 1000).toISOString() },
    { ...live('c-early', partyId), start: IN_A_YEAR }
  ]);

  const req = { user: { sub: 's2' } };
  await attachCredentials(req);
  assert.deepStrictEqual(req.credentials.map(c => c.id), ['c-live']);
  forgetCachedParty('s2');
});

test('a failed lookup leaves the caller with none', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  t.mock.method(repo, 'listForParty', async () => { throw new Error('Cosmos is down'); });

  const req = { user: { sub: 's3' } };
  await attachCredentials(req);
  assert.deepStrictEqual(req.credentials, [], 'fail closed, and never throw into the request');
});
