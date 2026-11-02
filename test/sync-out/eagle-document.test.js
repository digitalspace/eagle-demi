'use strict';

// What matters is which eagle-api calls a document send makes, in what order, and that a second
// delivery racing the first makes none.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const documents = require('../../src/repositories/documents');
const projects = require('../../src/repositories/projects');
const { logger } = require('../../src/utils/logger');
const syncOut = require('../../src/sync-out');
const pending = require('../../src/sync-out/pending');
const eagle = require('../../src/sync-out/eagle');
const consumer = require('../../src/sync-out/eagle-document');
const { DOCUMENT, kindOf } = require('../../src/sync-out/kinds');
const documentController = require('../../src/controllers/nosql/document');
const aiSearch = require('../../src/search/ai-search');
const { mirrorStore } = require('../helpers/mirror-store');
const { mockRes, STAFF, PROJECT_EAGLE_ID, storedEagleProject } = require('../helpers/eagle-mirror-fixtures');
const { API, useEnv, wireQueue, wireEagle, keys } = require('../helpers/sync-out-eagle');

const EAGLE_ID = '5cf00c03a266b7e1877504dd';
const ROW_ID = '7d1e2f40-0000-4000-8000-0000000000d1';
const PUBLIC_ACL = ['public', 'staff', 'sysadmin'];
const STAFF_ACL = ['staff', 'sysadmin'];
const PARENT_EAGLE_ID = '5cf00c03a266b7e1877504db';
const MAX_ATTEMPTS = 3;
const NATIVE_ENV = { SYNC_OUT_EAGLE_NATIVE_ENABLED: 'true' };

const ENV = {
  SYNC_OUT_EAGLE_ENABLED: 'true',
  SYNC_OUT_EAGLE_DOCUMENT_ENABLED: 'true',
  EAGLE_PROTECTED_API_BASE: API,
  EAGLE_KC_CLIENT_ID: 'demi-sync-out',
  EAGLE_KC_CLIENT_SECRET: 'not-a-real-value',
  EAGLE_ENGAGE_MILESTONE: '5cf00c03a266b7e1877504aa'
};

function demiRow(overrides = {}) {
  return {
    id: ROW_ID,
    projectId: '1234',
    sourceSystem: 'demi',
    eagleId: EAGLE_ID,
    syncVersion: 2,
    displayName: 'Draft plan',
    description: 'The draft plan for comment.',
    typeId: '5cf00c03a266b7e18775aa01',
    milestoneId: '5cf00c03a266b7e18775aa02',
    documentAuthorTypeId: '5cf00c03a266b7e18775aa04',
    datePosted: '2026-11-01T07:00:00.000Z',
    dateUploaded: '2026-10-30T07:00:00.000Z',
    legislation: 2018,
    sortOrder: 3,
    eaoStatus: 'Published',
    s3Key: 'docs/draft-plan.pdf',
    fileSize: 1024,
    contentExtracted: true,
    read: PUBLIC_ACL,
    isPublished: true,
    ...overrides
  };
}

/** A row as `createDocument` writes it: no Eagle id, `fileExt`, `documentFileName` or `syncVersion`. */
const nativeRow = (overrides = {}) => ({
  id: ROW_ID,
  projectId: '1234',
  sourceSystem: 'demi',
  displayName: 'Report',
  s3Key: 'p/abc.pdf',
  region: '',
  edrmsRecordNumber: '',
  orcsClassification: '',
  read: STAFF_ACL,
  isPublished: false,
  isDeleted: false,
  contentExtracted: false,
  ...overrides
});

/** The parent project `projects.readForWrite` answers, `syncOut` as its own sync-out left it. */
function wireParent(t, parent = { id: '1234', eagleId: PARENT_EAGLE_ID }) {
  t.mock.method(projects, 'readForWrite', async id => (String(id) === '1234' && parent ? structuredClone(parent) : null));
}

/** A parent project sync-out minted and created in Eagle, with `eagle` overriding its send record. */
const mintedParent = (eagle = {}) => ({
  id: '1234', eagleId: PARENT_EAGLE_ID, syncOut: { eagle: { mintedId: PARENT_EAGLE_ID, ...eagle } }
});

/** A row sent before, whose last send left Eagle's copy at `published`. */
const sentRow = (published, overrides = {}) =>
  demiRow({ syncOut: { eagle: { status: 'sent', sentVersion: 1, published } }, ...overrides });

const SYNC_REPO = kindOf(DOCUMENT).repo;

/**
 * One row in Cosmos, whose replace honours IfMatch as Cosmos does: no etag, no check. `update` is the
 * engine's own etag-guarded write through the real repository.
 */
function wireStore(t, row) {
  const store = { row: { ...row, _etag: 'e1' }, writes: 0, etags: [] };
  t.mock.method(cosmos, 'readItem', async (container, id, pk) =>
    (container === 'documents' && id === store.row.id && pk === store.row.projectId ? structuredClone(store.row) : null));
  t.mock.method(cosmos, 'replace', async (_container, _id, _pk, item, etag) => {
    store.etags.push(etag);
    if (etag && etag !== store.row._etag) throw Object.assign(new Error('precondition'), { code: 412 });
    store.writes += 1;
    store.row = { ...structuredClone(item), _etag: `e${store.writes + 1}` };
    return structuredClone(store.row);
  });
  store.update = mutate => syncOut.updateRow(SYNC_REPO, store.row.id, store.row.projectId, mutate);
  return store;
}

const POST = 'POST /document/stored';
/** eagle-api stores the record under the `_id` it was sent. */
const accept = body => ({ body: { _id: body._id } });
/** `accept`, with eagle-api's staff-only echo landing on the row in `store` before it answers. */
const acceptEchoed = store => (body) => {
  store.row = { ...store.row, sources: { eagle: { _id: body._id, read: STAFF_ACL } }, _etag: 'e-echo' };
  return accept(body);
};
const message = (overrides = {}) =>
  ({ kind: DOCUMENT, consumer: 'eagle', id: ROW_ID, projectId: '1234', attempt: 1, ...overrides });
const lastAttempt = () => syncOut.run(message({ attempt: MAX_ATTEMPTS }), { attempt: MAX_ATTEMPTS, maxAttempts: MAX_ATTEMPTS });
const GET = `GET /document/${EAGLE_ID}`;
const PUT = `PUT /document/${EAGLE_ID}`;
const PUBLISH = `PUT /document/${EAGLE_ID}/publish`;
const UNPUBLISH = `PUT /document/${EAGLE_ID}/unpublish`;
/** eagle-api's GET answers a list, `read` always projected. */
const eagleCopy = read => ({ body: [{ _id: EAGLE_ID, read }] });
const logged = (level, text) => logger[level].mock.calls.filter(c => String(c.arguments[0]).includes(text));

test('sync-out of documents to Eagle', async (t) => {
  t.beforeEach((tt) => {
    useEnv(tt, ENV);
    eagle.clearToken();
    for (const level of ['info', 'warn', 'error']) tt.mock.method(logger, level, () => {});
  });

  await t.test('a first send PUTs the DEMI fields and publishes when Eagle\'s copy is not public', async (tt) => {
    const store = wireStore(tt, demiRow());
    const calls = wireEagle(tt, { [GET]: eagleCopy(STAFF_ACL), [PUT]: {}, [PUBLISH]: {} });

    const result = await consumer.send(store.row, { update: store.update });

    assert.deepStrictEqual(keys(calls), [GET, PUT, PUBLISH]);
    assert.deepStrictEqual(calls[1].body, {
      displayName: 'Draft plan',
      description: 'The draft plan for comment.',
      type: '5cf00c03a266b7e18775aa01',
      milestone: '5cf00c03a266b7e18775aa02',
      documentAuthorType: '5cf00c03a266b7e18775aa04',
      datePosted: '2026-11-01T07:00:00.000Z',
      dateUploaded: '2026-10-30T07:00:00.000Z',
      legislation: 2018,
      sortOrder: 3
    }, 'no read, eaoStatus, file or extraction fields');
    assert.deepStrictEqual(result, { status: 'sent', eagleId: EAGLE_ID });
    assert.deepStrictEqual(store.row.syncOut.eagle, { status: 'sent', published: true }, 'claim released, level kept');
    assert.strictEqual(logged('info', `document ${ROW_ID} sent to Eagle`).length, 1);
  });

  await t.test('the echo of a PUT leaves the row\'s fields and sync state alone, and nothing is sent again', async (tt) => {
    const store = mirrorStore(tt, [
      { container: 'projects', ...storedEagleProject() },
      { container: 'documents', ...sentRow(true, { projectId: '207' }) }
    ]);
    tt.mock.method(aiSearch, 'writeAcls', async (_index, rows) => rows.length);
    const queued = wireQueue(tt);
    const rowOf = () => store.rows('documents').find(r => r.id === ROW_ID);
    let echo = null;
    let before = null;
    let echoed = null;
    const calls = wireEagle(tt, {
      // eagle-api awaits its push to DEMI before it answers the PUT.
      [PUT]: async (body) => {
        before = rowOf();
        echo = mockRes();
        await documentController.upsertFromEagle({
          params: { eagleId: EAGLE_ID }, query: {}, user: STAFF,
          // Eagle's own title and level, so a mirror that copied them over DEMI's would show.
          body: {
            doc: { ...body, _id: EAGLE_ID, project: PROJECT_EAGLE_ID, displayName: 'Eagle title', read: STAFF_ACL },
            pushedAt: Date.now()
          }
        }, echo);
        echoed = rowOf();
        return {};
      }
    });
    const message = { kind: DOCUMENT, consumer: 'eagle', id: ROW_ID, projectId: '207', attempt: 1 };

    const result = await syncOut.run(message);

    assert.deepStrictEqual(keys(calls), [PUT]);
    assert.strictEqual(echo.statusCode, 200, 'the echo is accepted');
    const { sources, _etag: _e, eaglePushedAt: _p, ...fields } = echoed;
    const { sources: _bs, _etag: _be, ...was } = before;
    assert.deepStrictEqual(fields, was, 'the echo changed no DEMI field, syncOut or syncVersion');
    assert.strictEqual(sources?.eagle?._id, EAGLE_ID, 'the echo landed on this row');
    assert.strictEqual(store.rows('documents').length, 1, 'the echo made no second row');
    assert.deepStrictEqual(result, { status: 'sent', eagleId: EAGLE_ID });
    assert.strictEqual(rowOf().syncOut.eagle.sentVersion, 2);
    assert.deepStrictEqual(queued, [], 'the echo queues nothing');

    wireEagle(tt, {});
    assert.deepStrictEqual(await syncOut.run(message), { skipped: 'current' }, 'no second send');
  });

  await t.test('a document message runs through the document consumer and records the sent version', async (tt) => {
    const store = wireStore(tt, sentRow(true));
    const calls = wireEagle(tt, { [PUT]: {} });

    const result = await syncOut.run({ kind: DOCUMENT, consumer: 'eagle', id: ROW_ID, projectId: '1234', attempt: 1 });

    assert.deepStrictEqual(keys(calls), [PUT], 'not the comment period consumer, which shares the name');
    assert.deepStrictEqual(result, { status: 'sent', eagleId: EAGLE_ID });
    assert.strictEqual(store.row.syncOut.eagle.sentVersion, 2);
  });

  await t.test('a first send leaves Eagle\'s level alone when it already matches', async (tt) => {
    const store = wireStore(tt, demiRow({ read: STAFF_ACL, isPublished: false }));
    const calls = wireEagle(tt, { [GET]: eagleCopy(STAFF_ACL), [PUT]: {} });

    await consumer.send(store.row, { update: store.update });

    assert.deepStrictEqual(keys(calls), [GET, PUT], 'no unpublish, which would mark it Rejected');
    assert.strictEqual(store.row.syncOut.eagle.published, false);
  });

  await t.test('Eagle\'s raw copy at public with DEMI at staff unpublishes without asking Eagle first', async (tt) => {
    const store = wireStore(tt, demiRow({
      read: STAFF_ACL, isPublished: false, sources: { eagle: { _id: EAGLE_ID, read: PUBLIC_ACL } }
    }));
    const calls = wireEagle(tt, { [PUT]: {}, [UNPUBLISH]: {} });

    await consumer.send(store.row, { update: store.update });

    assert.deepStrictEqual(keys(calls), [PUT, UNPUBLISH]);
    assert.strictEqual(store.row.syncOut.eagle.published, false);
  });

  await t.test('Eagle\'s raw copy at DEMI\'s level wins over a stale stored level and PUTs only', async (tt) => {
    const store = wireStore(tt, sentRow(true, {
      read: STAFF_ACL, isPublished: false, sources: { eagle: { _id: EAGLE_ID, read: STAFF_ACL } }
    }));
    const calls = wireEagle(tt, { [PUT]: {} });

    await consumer.send(store.row, { update: store.update });

    assert.deepStrictEqual(keys(calls), [PUT], 'no unpublish, which would mark it Rejected');
  });

  await t.test('a first send to an Eagle id Eagle no longer holds fails before any PUT', async (tt) => {
    const store = wireStore(tt, demiRow());
    const calls = wireEagle(tt, { [GET]: { body: [] }, [PUT]: {} });

    await assert.rejects(consumer.send(store.row, { update: store.update }), /Eagle has no document/);

    assert.deepStrictEqual(keys(calls), [GET]);
    assert.strictEqual(store.row.syncOut.eagle.status, 'failed');
  });

  await t.test('a level unchanged since the last send PUTs only, with no comment period milestone set', async (tt) => {
    delete process.env.EAGLE_ENGAGE_MILESTONE;
    const store = wireStore(tt, sentRow(false, { read: STAFF_ACL, isPublished: false }));
    const calls = wireEagle(tt, { [PUT]: {} });

    await consumer.send(store.row, { update: store.update });

    assert.deepStrictEqual(keys(calls), [PUT]);
  });

  await t.test('a level that moved since the last send unpublishes', async (tt) => {
    const store = wireStore(tt, sentRow(true, { read: STAFF_ACL, isPublished: false }));
    const calls = wireEagle(tt, { [PUT]: {}, [UNPUBLISH]: {} });

    await consumer.send(store.row, { update: store.update });

    assert.deepStrictEqual(keys(calls), [PUT, UNPUBLISH]);
    assert.strictEqual(store.row.syncOut.eagle.published, false);
  });

  await t.test('fields cleared in DEMI that eagle-api cannot clear are named in one warn line', async (tt) => {
    const store = wireStore(tt, sentRow(true, {
      description: '', milestoneId: null, sortOrder: 0, projectPhaseId: null,
      sources: { eagle: { _id: EAGLE_ID, description: 'Old text', milestone: '5cf00c03a266b7e18775aa02', sortOrder: 0 } }
    }));
    wireEagle(tt, { [PUT]: {} });

    await consumer.send(store.row, { update: store.update });

    const warned = logged('warn', `document ${ROW_ID}: eagle-api cannot clear`);
    assert.strictEqual(warned.length, 1);
    assert.deepStrictEqual(warned[0].arguments[1].fields, ['description', 'milestoneId'],
      'not sortOrder or projectPhaseId, which Eagle never held either');
  });

  await t.test('a cleared field is not named when the row holds no Eagle raw copy', async (tt) => {
    const store = wireStore(tt, sentRow(true, { description: '' }));
    wireEagle(tt, { [PUT]: {} });

    await consumer.send(store.row, { update: store.update });

    assert.strictEqual(logged('info', `document ${ROW_ID} sent to Eagle`).length, 1);
    assert.strictEqual(logged('warn', 'eagle-api cannot clear').length, 0);
  });

  await t.test('with the native switch off a row without an eagleId is held, not wanted, and nothing is written',
    async (tt) => {
      const calls = wireEagle(tt, {});
      const noId = wireStore(tt, nativeRow());

      assert.strictEqual(consumer.wants(noId.row), false);
      assert.strictEqual(consumer.wants(demiRow({ sourceSystem: 'eagle' })), false);
      assert.strictEqual(consumer.wants(demiRow()), true);
      assert.deepStrictEqual(await consumer.send(noId.row, { update: noId.update }), { status: 'held' });
      assert.deepStrictEqual(calls, []);
      assert.strictEqual(noId.writes, 0);
      assert.strictEqual(noId.row.syncOut, undefined);
    });

  await t.test('with the native switch on, a row without an eagleId is wanted and the pending hook queues it', async (tt) => {
    useEnv(tt, { ...NATIVE_ENV, SYNC_OUT_QUEUE: 'sync-out' });
    tt.mock.method(documents, 'listSyncPending', async () => [nativeRow()]);
    const queued = wireQueue(tt);

    assert.strictEqual(consumer.wants(nativeRow()), true);
    const report = await pending.reconcile({ repair: true }, pending.depsFor(DOCUMENT));

    assert.deepStrictEqual(report.listed, [ROW_ID]);
    assert.deepStrictEqual(queued.map(q => [q.body.kind, q.body.id, q.body.repair]), [[DOCUMENT, ROW_ID, true]]);
  });

  await t.test('SYNC_OUT_EAGLE_DOCUMENT_ENABLED gates the consumer, not which rows it wants', () => {
    assert.strictEqual(consumer.enabled(), true);
    delete process.env.SYNC_OUT_EAGLE_DOCUMENT_ENABLED;

    assert.strictEqual(consumer.enabled(), false);
    assert.strictEqual(consumer.wants(demiRow()), true);
  });

  await t.test('a row Eagle deleted is not wanted and sends nothing', async (tt) => {
    const calls = wireEagle(tt, {});
    const store = wireStore(tt, demiRow({ syncOut: { eagle: { status: 'sent', sentVersion: 1, published: true, eagleDeleted: true } } }));

    assert.strictEqual(consumer.wants(store.row), false);
    assert.deepStrictEqual(await consumer.send(store.row, { update: store.update }), { status: 'skipped' });
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(store.writes, 0, 'no claim taken');
  });

  await t.test('two concurrent deliveries make one PUT', async (tt) => {
    const store = wireStore(tt, sentRow(false));
    const calls = wireEagle(tt, { [PUT]: {}, [PUBLISH]: {} });
    const row = structuredClone(store.row);

    const results = await Promise.allSettled([
      consumer.send(row, { update: store.update }),
      consumer.send(row, { update: store.update })
    ]);

    assert.deepStrictEqual(keys(calls), [PUT, PUBLISH]);
    assert.deepStrictEqual(results.filter(r => r.status === 'fulfilled').map(r => r.value),
      [{ status: 'sent', eagleId: EAGLE_ID }]);
    assert.match(results.find(r => r.status === 'rejected').reason.message, /another delivery is sending/);
    assert.strictEqual(store.etags[0], 'e1', 'the claim write is guarded on the revision it read');
  });

  await t.test('a claim lost during the PUT stops the send before publish and leaves the new claim', async (tt) => {
    const store = wireStore(tt, sentRow(false));
    const foreign = { status: 'creating', claim: 'another-delivery', claimedAt: new Date().toISOString() };
    const calls = wireEagle(tt, {
      [PUT]: () => {
        store.row = { ...store.row, syncOut: { eagle: { ...store.row.syncOut.eagle, ...foreign } }, _etag: 'e-foreign' };
        return {};
      }
    });

    await assert.rejects(consumer.send(store.row, { update: store.update }), /taken by another delivery/);

    assert.deepStrictEqual(keys(calls), [PUT]);
    const entry = store.row.syncOut.eagle;
    assert.deepStrictEqual({ status: entry.status, claim: entry.claim, claimedAt: entry.claimedAt }, foreign);
  });

  await t.test('a failed PUT logs one error, releases the claim and publishes nothing', async (tt) => {
    const store = wireStore(tt, sentRow(false));
    const calls = wireEagle(tt, { [PUT]: { status: 500, body: { message: 'down' } } });

    await assert.rejects(consumer.send(store.row, { update: store.update }), /HTTP 500/);

    assert.deepStrictEqual(keys(calls), [PUT]);
    assert.deepStrictEqual(store.row.syncOut.eagle, { status: 'failed', sentVersion: 1, published: false });
    assert.strictEqual(logged('error', `document ${ROW_ID} not sent`).length, 1);
  });

  await t.test('a native create POSTs under the minted id and its echo lands on the same row', async (tt) => {
    useEnv(tt, NATIVE_ENV);
    const store = mirrorStore(tt, [
      { container: 'projects', ...storedEagleProject() },
      { container: 'documents', ...nativeRow({ projectId: '207' }) }
    ]);
    tt.mock.method(aiSearch, 'writeAcls', async (_index, rows) => rows.length);
    wireQueue(tt);
    let echo = null;
    const calls = wireEagle(tt, {
      // eagle-api awaits its push to DEMI before it answers the POST.
      [POST]: async (body) => {
        echo = mockRes();
        await documentController.upsertFromEagle({
          params: { eagleId: body._id }, query: {}, user: STAFF,
          body: { doc: { ...body, read: STAFF_ACL }, pushedAt: Date.now() }
        }, echo);
        return accept(body);
      }
    });

    const result = await syncOut.run(message({ projectId: '207' }));

    assert.deepStrictEqual(keys(calls), [POST]);
    assert.strictEqual(echo.statusCode, 200, 'the echo is accepted');
    const rows = store.rows('documents');
    assert.strictEqual(rows.length, 1, 'the echo made no second row');
    const [row] = rows;
    assert.strictEqual(row.id, ROW_ID);
    assert.strictEqual(row.sourceSystem, 'demi');
    assert.strictEqual(calls[0].body._id, row.eagleId, 'POSTed under the id the row stores');
    assert.strictEqual(calls[0].body.project, PROJECT_EAGLE_ID, "the parent's Eagle id");
    assert.strictEqual(row.syncOut.eagle.status, 'sent');
    assert.deepStrictEqual(result, { status: 'sent', eagleId: row.eagleId });
  });

  await t.test('a createDocument row POSTs its name and type from displayName and s3Key, and nothing Eagle sets itself',
    async (tt) => {
      useEnv(tt, NATIVE_ENV);
      const store = wireStore(tt, nativeRow());
      wireParent(tt);
      const calls = wireEagle(tt, { [POST]: acceptEchoed(store) });

      await consumer.send(store.row, { update: store.update });

      assert.deepStrictEqual(calls[0].body, {
        displayName: 'Report',
        project: PARENT_EAGLE_ID,
        internalURL: 'p/abc.pdf',
        documentFileName: 'Report',
        internalExt: 'pdf',
        passedAVCheck: false,
        _id: store.row.eagleId
      }, 'no edrmsRecordNumber, mimeType, internalMime or documentSource');
    });

  await t.test('a public create publishes once after the POST; a staff-only one does not', async (tt) => {
    useEnv(tt, NATIVE_ENV);
    wireParent(tt);
    const publicRow = wireStore(tt, nativeRow({ read: PUBLIC_ACL, isPublished: true }));
    let calls = wireEagle(tt, { [POST]: acceptEchoed(publicRow), 'PUT *': {} });

    await consumer.send(publicRow.row, { update: publicRow.update });

    assert.deepStrictEqual(keys(calls), [POST, `PUT /document/${publicRow.row.eagleId}/publish`]);

    const staffRow = wireStore(tt, nativeRow());
    calls = wireEagle(tt, { [POST]: acceptEchoed(staffRow) });
    await consumer.send(staffRow.row, { update: staffRow.update });
    assert.deepStrictEqual(keys(calls), [POST]);
  });

  await t.test('a POST answered 409 PUTs the same id, asks Eagle its level when no echo shows it, and ends sent',
    async (tt) => {
      useEnv(tt, NATIVE_ENV);
      const store = wireStore(tt, nativeRow());
      wireParent(tt);
      const calls = wireEagle(tt, {
        [POST]: { status: 409, body: { message: 'exists' } }, 'PUT *': {}, 'GET *': eagleCopy(STAFF_ACL)
      });

      const result = await consumer.send(store.row, { update: store.update });

      const id = store.row.eagleId;
      assert.deepStrictEqual(keys(calls), [POST, `PUT /document/${id}`, `GET /document/${id}`], 'no unpublish');
      assert.strictEqual(store.row.syncOut.eagle.status, 'sent');
      assert.deepStrictEqual(result, { status: 'sent', eagleId: id });
    });

  await t.test('a 409 whose record Eagle cannot show fails the send and publishes nothing', async (tt) => {
    useEnv(tt, NATIVE_ENV);
    const store = wireStore(tt, nativeRow({ read: PUBLIC_ACL, isPublished: true }));
    wireParent(tt);
    const calls = wireEagle(tt, {
      [POST]: { status: 409, body: {} }, 'PUT *': {}, 'GET *': { status: 404, body: { message: 'not found' } }
    });

    await assert.rejects(consumer.send(store.row, { update: store.update }), /HTTP 404/);

    const id = store.row.eagleId;
    assert.deepStrictEqual(keys(calls), [POST, `PUT /document/${id}`, `GET /document/${id}`], 'no publish');
    assert.strictEqual(store.row.syncOut.eagle.status, 'failed');
  });

  await t.test('an echo that makes a second row under the Eagle id is logged for a hand merge', async (tt) => {
    useEnv(tt, NATIVE_ENV);
    const store = mirrorStore(tt, [
      { container: 'projects', ...storedEagleProject() },
      { container: 'documents', ...nativeRow({ projectId: '207' }) }
    ]);
    wireQueue(tt);
    const calls = wireEagle(tt, {
      [POST]: async (body) => {
        await cosmos.create('documents', { id: body._id, projectId: '207', sourceSystem: 'eagle', read: STAFF_ACL });
        return accept(body);
      },
      'GET *': eagleCopy(STAFF_ACL)
    });

    await syncOut.run(message({ projectId: '207' }));

    assert.strictEqual(keys(calls)[0], POST);
    assert.strictEqual(store.rows('documents').length, 2);
    const [line] = logged('error', 'echo created mirror twin');
    assert.ok(line, 'the twin is named');
    assert.strictEqual(line.arguments[1].twinRowId, calls[0].body._id);
  });

  await t.test('a public create that landed unrecorded, then made staff-only, is unpublished after its 409', async (tt) => {
    useEnv(tt, NATIVE_ENV);
    const minted = eagle.mintEagleId();
    const store = wireStore(tt, nativeRow({
      eagleId: minted,
      sources: { eagle: { _id: minted, read: PUBLIC_ACL } },
      syncOut: { eagle: { mintedId: minted, status: 'failed' } }
    }));
    wireParent(tt);
    const calls = wireEagle(tt, { [POST]: { status: 409, body: {} }, 'PUT *': {} });

    await consumer.send(store.row, { update: store.update });

    assert.deepStrictEqual(keys(calls), [POST, `PUT /document/${minted}`, `PUT /document/${minted}/unpublish`]);
    assert.strictEqual(store.row.syncOut.eagle.status, 'sent');
  });

  await t.test('a minted row whose create landed takes the PUT path', async (tt) => {
    useEnv(tt, NATIVE_ENV);
    const minted = eagle.mintEagleId();
    const store = wireStore(tt, nativeRow({
      eagleId: minted, syncOut: { eagle: { mintedId: minted, status: 'sent', sentVersion: 0, published: false } }
    }));
    const calls = wireEagle(tt, { 'PUT *': {} });

    await consumer.send(store.row, { update: store.update });

    assert.deepStrictEqual(keys(calls), [`PUT /document/${minted}`]);
  });

  await t.test('a Track parent with no eagleId ends failed, POSTs nothing and logs the error line', async (tt) => {
    useEnv(tt, NATIVE_ENV);
    const store = wireStore(tt, nativeRow());
    wireParent(tt, { id: '1234', eagleId: null, sources: { track: { track_project_id: 1234 } } });
    wireQueue(tt);
    const calls = wireEagle(tt, {});

    await lastAttempt();

    assert.deepStrictEqual(calls, []);
    assert.strictEqual(store.row.syncOut.eagle.status, 'failed');
    assert.strictEqual(store.row.eagleId, undefined, 'no id minted');
    assert.strictEqual(logged('error', `[sync-out eagle] project 1234 of row ${ROW_ID} has no eagleId`).length, 1);
  });

  await t.test('a parent not yet in Eagle stops the send before any claim', async (tt) => {
    useEnv(tt, NATIVE_ENV);
    const parents = {
      'minted, create not landed': mintedParent({ status: 'creating', claim: 'c', claimedAt: new Date().toISOString() }),
      'native, no eagleId': { id: '1234', eagleId: null },
      missing: null
    };
    for (const [name, parent] of Object.entries(parents)) {
      const store = wireStore(tt, nativeRow());
      wireParent(tt, parent);
      const calls = wireEagle(tt, {});

      await assert.rejects(consumer.send(store.row, { update: store.update }), /not yet in Eagle/, name);

      assert.deepStrictEqual(calls, [], name);
      assert.strictEqual(store.writes, 0, `${name}: no claim written`);
      assert.strictEqual(store.row.syncOut, undefined, name);
    }
    assert.strictEqual(logged('warn', 'parent project 1234 not yet in Eagle').length, 3);
  });

  await t.test('a parent whose create landed gets one POST, even when its later send failed', async (tt) => {
    useEnv(tt, NATIVE_ENV);
    for (const sendRecord of [{ status: 'sent', sentVersion: 1 }, { status: 'failed', sentVersion: 0 }]) {
      const store = wireStore(tt, nativeRow());
      wireParent(tt, mintedParent(sendRecord));
      const calls = wireEagle(tt, { [POST]: acceptEchoed(store) });

      await consumer.send(store.row, { update: store.update });

      assert.deepStrictEqual(keys(calls), [POST], JSON.stringify(sendRecord));
    }
  });

  await t.test('a row with no s3Key, or no type in fileExt or s3Key, POSTs nothing and ends failed', async (tt) => {
    useEnv(tt, NATIVE_ENV);
    wireParent(tt);
    wireQueue(tt);
    for (const s3Key of ['', 'p/abc']) {
      const store = wireStore(tt, nativeRow({ s3Key }));
      const calls = wireEagle(tt, {});

      await lastAttempt();

      assert.deepStrictEqual(calls, [], s3Key);
      assert.strictEqual(store.row.syncOut.eagle.status, 'failed', s3Key);
      assert.strictEqual(store.row.eagleId, undefined, s3Key);
    }
  });

  await t.test('a lapsed creating claim is retaken with the stored minted id, not a new one', async (tt) => {
    useEnv(tt, NATIVE_ENV);
    const minted = eagle.mintEagleId();
    const lapsed = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const store = wireStore(tt, nativeRow({
      eagleId: minted, syncOut: { eagle: { mintedId: minted, status: 'creating', claim: 'dead', claimedAt: lapsed } }
    }));
    wireParent(tt);
    const calls = wireEagle(tt, { [POST]: acceptEchoed(store) });

    await consumer.send(store.row, { update: store.update });

    assert.deepStrictEqual(keys(calls), [POST]);
    assert.strictEqual(calls[0].body._id, minted);
    assert.strictEqual(logged('info', 'minted Eagle id').length, 0, 'nothing minted');
    assert.strictEqual(store.row.syncOut.eagle.status, 'sent');
  });

  await t.test('two concurrent create deliveries make one POST', async (tt) => {
    useEnv(tt, NATIVE_ENV);
    const store = wireStore(tt, nativeRow());
    wireParent(tt);
    const calls = wireEagle(tt, { [POST]: acceptEchoed(store) });
    const row = structuredClone(store.row);

    const results = await Promise.allSettled([
      consumer.send(row, { update: store.update }),
      consumer.send(row, { update: store.update })
    ]);

    assert.deepStrictEqual(keys(calls), [POST]);
    assert.strictEqual(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.match(results.find(r => r.status === 'rejected').reason.message, /another delivery is creating/);
  });
});
