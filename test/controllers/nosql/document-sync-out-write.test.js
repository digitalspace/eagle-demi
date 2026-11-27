'use strict';

// Staff writes on a document DEMI owns must reach Eagle through sync-out, and a user delete only
// flags the row. Each case drives the controller over one in-memory Cosmos, then the sync-out run.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../../src/db/cosmos-nosql');
const documents = require('../../../src/repositories/documents');
const chunks = require('../../../src/repositories/chunks');
const aiSearch = require('../../../src/search/ai-search');
const syncOut = require('../../../src/sync-out');
const eagle = require('../../../src/sync-out/eagle');
const documentController = require('../../../src/controllers/nosql/document');
const { levelOfRead } = require('../../../src/helpers/access-sql');
const { NOT_DELETED } = require('../../../src/repositories/_sql');
const { logger } = require('../../../src/utils/logger');
const { mockRes } = require('../../helpers/mock-res');
const { API, useEnv, wireQueue, wireEagle, keys } = require('../../helpers/sync-out-eagle');

const ENV = {
  SYNC_OUT_EAGLE_ENABLED: 'true',
  SYNC_OUT_EAGLE_DOCUMENT_ENABLED: 'true',
  EAGLE_PROTECTED_API_BASE: API,
  EAGLE_KC_CLIENT_ID: 'demi-sync-out',
  EAGLE_KC_CLIENT_SECRET: 'not-a-real-value',
  EAGLE_ENGAGE_MILESTONE: '5cf00c03a266b7e1877504aa'
};

const EAGLE_ID = '5cf00c03a266b7e1877504dd';
const ROW_ID = '7d1e2f40-0000-4000-8000-0000000000d1';
const PUBLIC_ACL = ['public', 'staff', 'idir'];
const STAFF = { preferred_username: 'staff.user', realm_access: { roles: ['staff'] } };
const SYSADMIN = { preferred_username: 'admin.user', realm_access: { roles: ['sysadmin'] } };
const PUT = `PUT /document/${EAGLE_ID}`;
const UNPUBLISH = `PUT /document/${EAGLE_ID}/unpublish`;
const LIVE_ONLY = `FROM c WHERE ${NOT_DELETED.clause}`;
const precondition = () => Object.assign(new Error('precondition failed'), { code: 412 });

/** A DEMI row Eagle already holds as public, sent at version 0. */
const demiRow = (overrides = {}) => ({
  id: ROW_ID, projectId: '1234', sourceSystem: 'demi', eagleId: EAGLE_ID, displayName: 'Draft plan',
  read: PUBLIC_ACL, ownRead: PUBLIC_ACL, isPublished: true, syncVersion: 0,
  syncOut: { eagle: { status: 'sent', sentVersion: 0, published: true } },
  ...overrides
});

/** Cosmos over `rows` (`{ container, ...row }`): etag-guarded writes, and `set`/`incr` patches that judge the live-only condition. */
function wireStore(t, rows) {
  const partitionOf = (container, row) => (container === 'documents' ? row.projectId : row.id);
  const key = (container, id, pk) => `${container}|${id}|${pk}`;
  const store = { rows: new Map(), writes: 0, beforePatch: null };
  for (const { container, ...row } of rows) store.rows.set(key(container, row.id, partitionOf(container, row)), { ...row, _etag: 'e0' });
  const write = (container, item, etag) => {
    const at = key(container, item.id, partitionOf(container, item));
    const current = store.rows.get(at);
    if (etag && (!current || current._etag !== etag)) throw precondition();
    store.writes += 1;
    store.rows.set(at, { ...structuredClone(item), _etag: `e${store.writes}` });
    return structuredClone(store.rows.get(at));
  };
  t.mock.method(cosmos, 'readItem', async (container, id, pk) => structuredClone(store.rows.get(key(container, id, pk)) ?? null));
  t.mock.method(cosmos, 'upsert', async (container, item, { etag } = {}) => write(container, item, etag));
  t.mock.method(cosmos, 'replace', async (container, _id, _pk, item, etag) => write(container, item, etag));
  t.mock.method(cosmos, 'query', async () => ({ items: [] }));
  t.mock.method(cosmos, 'patch', async (container, id, pk, operations, condition) => {
    if (store.beforePatch) store.beforePatch();
    const row = store.rows.get(key(container, id, pk));
    assert.ok(condition === undefined || condition === LIVE_ONLY, `unjudged patch condition ${condition}`);
    if (condition && row.isDeleted === true) throw precondition();
    const next = { ...row };
    for (const op of operations) {
      const field = op.path.slice(1);
      if (op.op === 'set') next[field] = op.value;
      else if (op.op === 'incr') next[field] = (next[field] ?? 0) + op.value;
      else throw new Error(`unknown patch op ${op.op}`);
    }
    return write(container, next);
  });
  store.doc = () => structuredClone(store.rows.get(key('documents', ROW_ID, '1234')));
  return store;
}

const call = async (handler, req) => {
  const res = mockRes();
  await documentController[handler]({ params: { id: ROW_ID }, query: { project: '1234' }, ...req }, res);
  return res;
};

test('DEMI-owned document writes and deletes', async (t) => {
  t.beforeEach((tt) => {
    useEnv(tt, ENV);
    eagle.clearToken();
    for (const level of ['info', 'warn', 'error']) tt.mock.method(logger, level, () => {});
    tt.mock.method(aiSearch, 'writeAcls', async (_index, rows) => rows.length);
    tt.mock.method(chunks, 'setAclForDocument', async () => ({ succeeded: 0, failed: 0 }));
  });

  await t.test('a staff edit of a sent row raises its version, so the run PUTs the new name', async (tt) => {
    wireStore(tt, [{ container: 'documents', ...demiRow() }]);
    const queued = wireQueue(tt);
    const calls = wireEagle(tt, { [PUT]: {} });

    const res = await call('updateDocument', { user: STAFF, body: { displayName: 'Final plan' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(queued.length, 1);

    const result = await syncOut.run(queued[0].body);
    assert.deepStrictEqual(result, { status: 'sent', eagleId: EAGLE_ID });
    assert.deepStrictEqual(keys(calls), [PUT]);
    assert.strictEqual(calls[0].body.displayName, 'Final plan');
  });

  await t.test('a staff narrow to level 2 reaches Eagle as an unpublish', async (tt) => {
    wireStore(tt, [{ container: 'documents', ...demiRow() }]);
    const queued = wireQueue(tt);
    const calls = wireEagle(tt, { [PUT]: {}, [UNPUBLISH]: {} });

    const res = await call('setLevel', { user: STAFF, body: { level: 2, reason: 'withdrawn by the proponent' } });
    assert.strictEqual(res.statusCode, 200);

    await syncOut.run(queued[0].body);
    assert.deepStrictEqual(keys(calls), [PUT, UNPUBLISH]);
  });

  await t.test('an edit or level move of an Eagle row leaves its syncVersion alone', async (tt) => {
    const store = wireStore(tt, [{ container: 'documents', ...demiRow({ sourceSystem: 'eagle', syncVersion: undefined, syncOut: undefined }) }]);
    wireQueue(tt);

    assert.strictEqual((await call('updateDocument', { user: STAFF, body: { displayName: 'Renamed' } })).statusCode, 200);
    assert.strictEqual((await call('setLevel', { user: STAFF, body: { level: 2, reason: 'withdrawn' } })).statusCode, 200);
    assert.strictEqual(store.doc().syncVersion, undefined);
  });

  await t.test('a staff publish under a public notification passes, under a staff-only one it is refused', async (tt) => {
    const row = demiRow({ projectId: 'n1', read: ['staff'], ownRead: ['staff'], isPublished: false });
    const publish = { user: STAFF, query: { project: 'n1' }, body: { level: 4, confirm: true, reason: 'release' } };
    wireStore(tt, [{ container: 'documents', ...row }, { container: 'notifications', id: 'n1', read: PUBLIC_ACL }]);
    wireQueue(tt);
    assert.strictEqual((await call('setLevel', publish)).statusCode, 200);

    wireStore(tt, [{ container: 'documents', ...row }, { container: 'notifications', id: 'n1', read: ['staff'] }]);
    assert.strictEqual((await call('setLevel', publish)).statusCode, 409);
  });

  await t.test('a level move of a flagged row answers 404 and writes nothing', async (tt) => {
    const store = wireStore(tt, [{ container: 'documents', ...demiRow({ isDeleted: true, read: ['staff'] }) }]);
    const queued = wireQueue(tt);

    const res = await call('setLevel', { user: STAFF, body: { level: 4, confirm: true, reason: 'release' } });
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(store.writes, 0);
    assert.strictEqual(queued.length, 0);
  });

  await t.test('a delete landing between the read and the level patch answers 404 and queues nothing', async (tt) => {
    const store = wireStore(tt, [{ container: 'documents', ...demiRow() }]);
    const queued = wireQueue(tt);
    store.beforePatch = () => { store.rows.get(`documents|${ROW_ID}|1234`).isDeleted = true; };

    const res = await call('setLevel', { user: STAFF, body: { level: 2, reason: 'withdrawn' } });
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(store.writes, 0);
    assert.strictEqual(queued.length, 0);
  });

  await t.test('a delete flags the row at level 2 and keeps it, its chunks and its file', async (tt) => {
    const store = wireStore(tt, [{ container: 'documents', ...demiRow() }]);
    const queued = wireQueue(tt);
    const removeChunks = tt.mock.method(chunks, 'removeForDocument', async () => ({ succeeded: 0, failed: 0 }));
    const deleteById = tt.mock.method(documents, 'deleteById', async () => true);

    const res = await call('deleteDocument', { user: STAFF });
    assert.strictEqual(res.statusCode, 200);
    const stored = store.doc();
    assert.strictEqual(stored.isDeleted, true);
    assert.strictEqual(levelOfRead(stored.read), 2);
    assert.strictEqual(stored.deletedBy, 'staff.user');
    assert.strictEqual(stored.syncVersion, 1);
    assert.strictEqual(removeChunks.mock.callCount(), 0);
    assert.strictEqual(deleteById.mock.callCount(), 0);
    assert.strictEqual(aiSearch.writeAcls.mock.calls[0].arguments[1][0].isDeleted, true);
    assert.strictEqual(queued.length, 1);

    assert.strictEqual((await call('getDocument', { user: STAFF })).statusCode, 404);
    assert.strictEqual((await call('deleteDocument', { user: STAFF })).statusCode, 404, 'a repeat finds nothing to delete');
  });

  await t.test('a delete of an Eagle row answers 409 and writes nothing', async (tt) => {
    const store = wireStore(tt, [{ container: 'documents', ...demiRow({ sourceSystem: 'eagle' }) }]);

    const res = await call('deleteDocument', { user: SYSADMIN });
    assert.strictEqual(res.statusCode, 409);
    assert.match(res.body.error, /held in Eagle; delete it through eagle-api/);
    assert.strictEqual(store.writes, 0);
  });

  await t.test('a purge needs sysadmin: staff get 403 and nothing is written', async (tt) => {
    const store = wireStore(tt, [{ container: 'documents', ...demiRow() }]);
    const deleteById = tt.mock.method(documents, 'deleteById', async () => true);

    const res = await call('deleteDocument', { user: STAFF, query: { project: '1234', purge: 'true' } });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(store.writes, 0);
    assert.strictEqual(deleteById.mock.callCount(), 0);
  });

  await t.test('a sysadmin delete without purge only flags', async (tt) => {
    const store = wireStore(tt, [{ container: 'documents', ...demiRow() }]);
    wireQueue(tt);
    const deleteById = tt.mock.method(documents, 'deleteById', async () => true);

    assert.strictEqual((await call('deleteDocument', { user: SYSADMIN })).statusCode, 200);
    assert.strictEqual(store.doc().isDeleted, true);
    assert.strictEqual(deleteById.mock.callCount(), 0);
  });
});
