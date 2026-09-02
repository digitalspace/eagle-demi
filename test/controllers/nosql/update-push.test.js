'use strict';

/**
 * The Updates mirror — `PUT /eagle/updates/:eagleId`.
 *
 * Two invariants, both silent when they break because the push still answers 200: the stored row
 * keeps the notification claim across an upsert (Cosmos REPLACES the item), and eagle-notify hears
 * about a publication exactly once. The claim is what makes "once" true, so most of this file is
 * about who holds it.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../../src/db/cosmos-nosql');
const updates = require('../../../src/repositories/updates');
const projects = require('../../../src/repositories/projects');
const notify = require('../../../src/services/notify');
const controller = require('../../../src/controllers/nosql/update');
const { routeChains } = require('../../helpers/router-source');

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    setHeader() {}
  };
}

const STAFF = { sub: 'kc-sub-1', preferred_username: 'push', realm_access: { roles: ['sysadmin'] } };
const UPDATE_EAGLE_ID = '5f0e4a0c3f4b1a0021a1b2c3';
const PROJECT_EAGLE_ID = '588511d0aaecd9001b825604';

/** A raw Eagle RecentActivity, as eagle-api stores it. */
function eagleUpdate(overrides = {}) {
  return {
    _id: UPDATE_EAGLE_ID,
    headline: 'Public comment period opens',
    content: '<p>The comment period opens on Monday.</p>',
    type: 'News',
    project: PROJECT_EAGLE_ID,
    active: true,
    pinned: false,
    dateAdded: '2026-08-01T00:00:00.000Z',
    dateUpdated: '2026-08-02T00:00:00.000Z',
    read: ['public', 'sysadmin', 'staff'],
    ...overrides
  };
}

function push(body, res = mockRes()) {
  return controller.upsertFromEagle(
    { params: { eagleId: UPDATE_EAGLE_ID }, query: {}, body, user: STAFF }, res
  ).then(() => res);
}

/** The mirror with eagle-notify wired up: every claim call is recorded, no HTTP happens. */
function wiredNotify(t, { claim = () => ({ id: UPDATE_EAGLE_ID }), pushed = true } = {}) {
  const seen = { claims: [], releases: [], published: [], cancelled: [] };
  t.mock.method(notify, 'configured', () => true);
  t.mock.method(updates, 'claimForNotify', async (id, now) => {
    seen.claims.push({ id, now });
    return claim();
  });
  t.mock.method(updates, 'releaseNotify', async (id) => { seen.releases.push(id); });
  t.mock.method(notify, 'updatePublished', async (item, projectName) => {
    seen.published.push({ item, projectName });
    return pushed;
  });
  t.mock.method(notify, 'updateCancelled', async (item) => { seen.cancelled.push(item); return true; });
  return seen;
}

test('PUT /eagle/updates/:eagleId', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('the raw Eagle record is stored as an update row', async () => {
    t.mock.method(updates, 'getById', async () => null);
    let written;
    t.mock.method(updates, 'upsert', async (item) => { written = item; return item; });

    const res = await push({ doc: eagleUpdate() });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { id: UPDATE_EAGLE_ID, action: 'upsert' });
    assert.deepStrictEqual(written, {
      id: UPDATE_EAGLE_ID,
      eagleId: UPDATE_EAGLE_ID,
      projectId: PROJECT_EAGLE_ID,
      headline: 'Public comment period opens',
      content: '<p>The comment period opens on Monday.</p>',
      type: 'News',
      pinned: false,
      dateAdded: '2026-08-01T00:00:00.000Z',
      dateUpdated: '2026-08-02T00:00:00.000Z',
      isPublished: true,
      read: ['public', 'sysadmin', 'staff'],
      notifiedAt: null,
      sources: { eagle: eagleUpdate() }
    });
  });

  await t.test('an update with no project is site-wide, not orphaned', async () => {
    t.mock.method(updates, 'getById', async () => null);
    let written;
    t.mock.method(updates, 'upsert', async (item) => { written = item; return item; });

    await push({ doc: eagleUpdate({ project: null, active: false }) });

    assert.strictEqual(written.projectId, null);
    assert.strictEqual(written.isPublished, false, 'active: false is unpublished');
  });

  await t.test('the notification claim survives an upsert', async () => {
    // Cosmos REPLACES the item, so without this every push of a published update re-notifies.
    t.mock.method(updates, 'getById', async () => ({
      id: UPDATE_EAGLE_ID, isPublished: true, notifiedAt: '2026-08-01T12:00:00.000Z',
      sources: { eagle: {} }
    }));
    let written;
    t.mock.method(updates, 'upsert', async (item) => { written = item; return item; });

    await push({ doc: eagleUpdate() });

    assert.strictEqual(written.notifiedAt, '2026-08-01T12:00:00.000Z');
  });

  await t.test('a publication is announced once, with the project name', async () => {
    t.mock.method(updates, 'getById', async () => null);
    t.mock.method(updates, 'upsert', async (item) => item);
    t.mock.method(projects, 'getByEagleId', async () => ({ id: '207', name: 'Nicomen Wind Energy' }));
    const seen = wiredNotify(t);

    const res = await push({ doc: eagleUpdate() });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(seen.claims.length, 1);
    assert.strictEqual(seen.claims[0].id, UPDATE_EAGLE_ID);
    assert.match(seen.claims[0].now, /^\d{4}-\d{2}-\d{2}T/);
    assert.strictEqual(seen.published.length, 1);
    assert.strictEqual(seen.published[0].projectName, 'Nicomen Wind Energy');
    assert.strictEqual(seen.published[0].item.id, UPDATE_EAGLE_ID);
    assert.deepStrictEqual(seen.releases, []);
  });

  await t.test('a project-less update is announced with no project name', async () => {
    t.mock.method(updates, 'getById', async () => null);
    t.mock.method(updates, 'upsert', async (item) => item);
    t.mock.method(projects, 'getByEagleId', async () => { throw new Error('must not be looked up'); });
    const seen = wiredNotify(t);

    await push({ doc: eagleUpdate({ project: null }) });

    assert.strictEqual(seen.published.length, 1);
    assert.strictEqual(seen.published[0].projectName, null);
  });

  await t.test('a second push of the same active update announces nothing', async () => {
    // The claim is already held, so claimForNotify answers null (Cosmos 412) rather than patching.
    t.mock.method(updates, 'getById', async () => ({
      id: UPDATE_EAGLE_ID, isPublished: true, notifiedAt: '2026-08-01T12:00:00.000Z'
    }));
    t.mock.method(updates, 'upsert', async (item) => item);
    const seen = wiredNotify(t, { claim: () => null });

    const res = await push({ doc: eagleUpdate({ headline: 'Edited headline' }) });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(seen.claims.length, 1, 'the claim is attempted');
    assert.deepStrictEqual(seen.published, [], 'and refused, so nothing is sent');
  });

  await t.test('a failed push releases the claim, so the next push retries', async () => {
    t.mock.method(updates, 'getById', async () => null);
    t.mock.method(updates, 'upsert', async (item) => item);
    t.mock.method(projects, 'getByEagleId', async () => ({ id: '207', name: 'Nicomen Wind Energy' }));
    const seen = wiredNotify(t, { pushed: false });

    const res = await push({ doc: eagleUpdate() });

    assert.strictEqual(res.statusCode, 200, 'a notification failure never fails the mirror');
    assert.deepStrictEqual(seen.releases, [UPDATE_EAGLE_ID]);
  });

  await t.test('unpublishing an announced update cancels it and frees the claim', async () => {
    t.mock.method(updates, 'getById', async () => ({
      id: UPDATE_EAGLE_ID, isPublished: true, notifiedAt: '2026-08-01T12:00:00.000Z'
    }));
    t.mock.method(updates, 'upsert', async (item) => item);
    const seen = wiredNotify(t);

    await push({ doc: eagleUpdate({ active: false }) });

    assert.deepStrictEqual(seen.releases, [UPDATE_EAGLE_ID]);
    assert.strictEqual(seen.cancelled.length, 1);
    assert.strictEqual(seen.cancelled[0].isPublished, false);
    assert.deepStrictEqual(seen.claims, [], 'an unpublish takes no claim');
  });

  await t.test('unpublishing an update nobody announced sends nothing', async () => {
    t.mock.method(updates, 'getById', async () => ({
      id: UPDATE_EAGLE_ID, isPublished: false, notifiedAt: null
    }));
    t.mock.method(updates, 'upsert', async (item) => item);
    const seen = wiredNotify(t);

    await push({ doc: eagleUpdate({ active: false }) });

    assert.deepStrictEqual(seen.cancelled, []);
    assert.deepStrictEqual(seen.releases, []);
  });

  await t.test('a notify failure is logged, not returned', async () => {
    t.mock.method(updates, 'getById', async () => null);
    t.mock.method(updates, 'upsert', async (item) => item);
    t.mock.method(notify, 'configured', () => true);
    t.mock.method(updates, 'claimForNotify', async () => { throw new Error('Cosmos is down'); });

    const res = await push({ doc: eagleUpdate() });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { id: UPDATE_EAGLE_ID, action: 'upsert' });
  });

  await t.test('dark: no claim is taken and nothing is sent', async () => {
    // A claim taken while dark would suppress the FIRST real notification once the environment is
    // wired up, which is the one that matters.
    t.mock.method(updates, 'getById', async () => null);
    t.mock.method(updates, 'upsert', async (item) => item);
    t.mock.method(notify, 'configured', () => false);
    let claims = 0;
    t.mock.method(updates, 'claimForNotify', async () => { claims++; });
    const fetches = [];
    const realFetch = global.fetch;
    global.fetch = async (...args) => { fetches.push(args); };

    try {
      const res = await push({ doc: eagleUpdate() });
      assert.strictEqual(res.statusCode, 200);
    } finally {
      global.fetch = realFetch;
    }

    assert.strictEqual(claims, 0);
    assert.deepStrictEqual(fetches, []);
  });

  await t.test('a body whose doc._id disagrees with the path is a 400 and no write', async () => {
    t.mock.method(updates, 'getById', async () => { throw new Error('must not be read'); });
    let upserts = 0;
    t.mock.method(updates, 'upsert', async () => { upserts++; });

    for (const body of [{ doc: eagleUpdate({ _id: 'somethingelse' }) }, {}, { doc: null }]) {
      const res = await push(body);
      assert.strictEqual(res.statusCode, 400);
    }
    assert.strictEqual(upserts, 0);
  });
});

test('the notification claim is a conditional patch', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('it patches notifiedAt only while unclaimed', async () => {
    const calls = [];
    t.mock.method(cosmos, 'patch', async (container, id, pk, operations, condition) => {
      calls.push({ container, id, pk, operations, condition });
      return { id, notifiedAt: operations[0].value };
    });

    const claimed = await updates.claimForNotify(UPDATE_EAGLE_ID, '2026-08-01T12:00:00.000Z');

    assert.strictEqual(claimed.notifiedAt, '2026-08-01T12:00:00.000Z');
    assert.deepStrictEqual(calls[0].operations,
      [{ op: 'set', path: '/notifiedAt', value: '2026-08-01T12:00:00.000Z' }]);
    assert.strictEqual(calls[0].container, 'updates');
    assert.strictEqual(calls[0].pk, UPDATE_EAGLE_ID, 'the partition key is the id');
    assert.match(calls[0].condition, /NOT IS_DEFINED\(c\.notifiedAt\) OR IS_NULL\(c\.notifiedAt\)/);
  });

  await t.test('a 412 means somebody else claimed it, not an error', async () => {
    t.mock.method(cosmos, 'patch', async () => { throw Object.assign(new Error('precondition'), { code: 412 }); });
    assert.strictEqual(await updates.claimForNotify(UPDATE_EAGLE_ID, 'now'), null);
  });

  await t.test('any other Cosmos error still throws', async () => {
    t.mock.method(cosmos, 'patch', async () => { throw Object.assign(new Error('throttled'), { code: 429 }); });
    await assert.rejects(() => updates.claimForNotify(UPDATE_EAGLE_ID, 'now'), /throttled/);
  });

  await t.test('releasing writes an explicit null, with no condition', async () => {
    const calls = [];
    t.mock.method(cosmos, 'patch', async (container, id, pk, operations, condition) => {
      calls.push({ operations, condition });
      return { id };
    });

    await updates.releaseNotify(UPDATE_EAGLE_ID);

    assert.deepStrictEqual(calls[0].operations, [{ op: 'set', path: '/notifiedAt', value: null }]);
    assert.strictEqual(calls[0].condition, undefined);
  });
});

test('the updates mirror route is behind authMiddleware + requireWrite', () => {
  // The handler reads and writes through systemAccess(), so the route chain is the whole gate.
  const route = routeChains().find(r => r.path === '/eagle/updates/:eagleId');
  assert.ok(route, 'no PUT /eagle/updates/:eagleId route');
  assert.strictEqual(route.method, 'put');
  assert.match(route.chain, /\bauthMiddleware\b/);
  assert.match(route.chain, /\brequireWrite\b/);
});
