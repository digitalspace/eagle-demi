'use strict';

// The work, phase and event routes under /track/projects/:pid through the real record writer, over
// in-memory projects and works containers. Assertions are on the answer and the stored documents.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const lists = require('../../../src/repositories/lists');
const projects = require('../../../src/repositories/projects');
const works = require('../../../src/repositories/works');
const trackPush = require('../../../src/controllers/nosql/track-push');
const { logger } = require('../../../src/utils/logger');
const { mirrorStore } = require('../../helpers/mirror-store');
const { mockRes } = require('../../helpers/mock-res');
const { useConfig } = require('../../helpers/use-config');
const { STAFF } = require('../../helpers/eagle-mirror-fixtures');
const { recordEvents } = require('../../helpers/record-events');
const config = require('../../../src/config');

const PID = '1001';
const LATER = 1762675200000 + 1000;

const fixture = (name) => structuredClone(require(`../../fixtures/track-records/${name}.json`));
const writesTo = (store, container) => store.writes.filter(w => w.container === container);

/** The fixture's first phase as a phase record with a changed length, stamped `pushedAt`. */
function phaseRecord(pushedAt = LATER, changes = { number_of_days: 120 }) {
  const { events: _events, ...phase } = fixture('new_work').work.phases[0];
  return { pushedAt, workTypeId: 6, phase: { ...phase, work_id: 2001, ...changes } };
}

const TRACK_ROW = { container: 'projects', id: PID, name: 'Payload Contract Mine', read: ['public'], sources: { track: { track_project_id: 1001 } } };

async function call(handler, { params = {}, query = {}, body } = {}) {
  const res = mockRes();
  await trackPush[handler]({ params: { pid: PID, ...params }, query, body, user: STAFF }, res);
  return res;
}

/** Flag on, the project row stored, and the fixture work posted through its route; `writes` emptied after. */
async function seeded(t, { rows = [TRACK_ROW] } = {}) {
  useConfig(t, { worksWrite: true });
  t.mock.method(lists, 'readCatalog', async () => null);
  const store = mirrorStore(t, rows);
  if (rows.length) assert.strictEqual((await call('postTrackWork', { body: fixture('new_work') })).statusCode, 200);
  store.writes.length = 0;
  return store;
}

test('Track work, phase and event routes', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a phase PUT writes one work document and no project row', async (t) => {
    const store = await seeded(t);

    const res = await call('putTrackPhase', { params: { id: '3001' }, body: phaseRecord() });

    assert.deepStrictEqual(res.body, { id: '3001', action: 'applied' });
    assert.deepStrictEqual([writesTo(store, 'works').length, writesTo(store, 'projects').length], [1, 0]);
  });

  await t.test('a lost derived patch answers 503 DERIVED_CONFLICT', async (t) => {
    await seeded(t);
    t.mock.method(projects, 'patchDerived', async () => ({ status: 'conflict' }));
    t.mock.method(logger, 'error', () => {});

    const res = await call('putTrackPhase', { params: { id: '3001' }, body: phaseRecord() });

    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.code, 'DERIVED_CONFLICT');
  });

  await t.test('a write whose derived patch is lost is still audited, since its retry answers unchanged', async (t) => {
    await seeded(t);
    const rows = recordEvents(t);
    t.mock.method(projects, 'patchDerived', async () => ({ status: 'conflict' }));
    t.mock.method(logger, 'error', () => {});

    await call('putTrackPhase', { params: { id: '3001' }, body: phaseRecord() });

    assert.strictEqual((await rows(config.auditStream)).length, 1);
  });

  await t.test('a work document that keeps losing its etag answers 503 and logs the record at error', async (t) => {
    await seeded(t);
    t.mock.method(works, 'save', async () => { throw Object.assign(new Error('moved'), { code: 412 }); });
    const errors = t.mock.method(logger, 'error', () => {});

    const res = await call('putTrackPhase', { params: { id: '3001' }, body: phaseRecord() });

    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(errors.mock.calls[0].arguments[0], `[track-push] write failed id=${PID}/phase:3001`);
  });

  await t.test('a phase whose work DEMI lacks answers 404 PARENT_NOT_FOUND, logged at warn', async (t) => {
    const store = await seeded(t);
    const warn = t.mock.method(logger, 'warn', () => {});
    const record = phaseRecord();
    record.phase.work_id = 9999;

    const res = await call('putTrackPhase', { params: { id: '3001' }, body: record });

    assert.deepStrictEqual([res.statusCode, res.body.code], [404, 'PARENT_NOT_FOUND']);
    assert.ok(warn.mock.calls[0].arguments[0].startsWith(`[track-push] refused id=${PID}/phase:3001`));
    assert.deepStrictEqual(store.writes, []);
  });

  await t.test('a record ahead of its project row answers PARENT_NOT_FOUND, which Track retries', async (t) => {
    await seeded(t, { rows: [] });
    t.mock.method(logger, 'warn', () => {});

    const res = await call('putTrackWork', { params: { id: '2001' }, body: fixture('work') });

    assert.deepStrictEqual([res.statusCode, res.body.code], [404, 'PARENT_NOT_FOUND']);
  });

  await t.test('a DELETE under a project DEMI lacks answers 404 with the id, which Track counts as gone', async (t) => {
    await seeded(t, { rows: [] });
    const query = { pushedAt: String(LATER), workTypeId: '6' };

    const res = await call('deleteTrackWork', { params: { id: '2001' }, query });

    assert.deepStrictEqual([res.statusCode, res.body.code, res.body.id], [404, 'PROJECT_NOT_FOUND', '2001']);
  });

  await t.test('a phase DELETE whose work DEMI lacks answers 404 RECORD_NOT_FOUND with the id, not a retry', async (t) => {
    await seeded(t);
    const query = { pushedAt: String(LATER), workTypeId: '6' };
    await call('deleteTrackWork', { params: { id: '2001' }, query });

    const res = await call('deleteTrackPhase', { params: { id: '3001' }, query: { ...query, pushedAt: String(LATER + 1) } });

    assert.deepStrictEqual([res.statusCode, res.body.code, res.body.id], [404, 'RECORD_NOT_FOUND', '3001']);
  });

  await t.test('a row with no Track source answers 200 skipped apiRow and writes nothing', async (t) => {
    const store = mirrorStore(t, [{ ...TRACK_ROW, sources: {} }]);
    useConfig(t, { worksWrite: true });
    t.mock.method(logger, 'warn', () => {});

    const res = await call('postTrackWork', { body: fixture('new_work') });

    assert.deepStrictEqual(res.body, { id: '2001', action: 'skipped', reason: 'apiRow' });
    assert.deepStrictEqual(store.writes, []);
  });

  await t.test('only a write a reader can see is audited', async (t) => {
    await seeded(t);
    const rows = recordEvents(t);

    const changed = await call('putTrackPhase', { params: { id: '3001' }, body: phaseRecord() });
    const again = await call('putTrackPhase', { params: { id: '3001' }, body: phaseRecord() });

    assert.deepStrictEqual([changed.body.action, again.body.action], ['applied', 'unchanged']);
    assert.strictEqual((await rows(config.auditStream)).length, 1);
  });

  await t.test('an older record answers 409 STALE_PUSH and writes nothing', async (t) => {
    const store = await seeded(t);

    const res = await call('putTrackPhase', { params: { id: '3001' }, body: phaseRecord(LATER - 2000) });

    assert.deepStrictEqual([res.statusCode, res.body.code], [409, 'STALE_PUSH']);
    assert.deepStrictEqual(store.writes, []);
  });

  await t.test('with the works flag off every child route answers 409 NOT_BACKFILLED', async (t) => {
    const store = mirrorStore(t, [{ container: 'projects', id: PID, read: ['public'] }]);
    useConfig(t, { worksWrite: false });
    t.mock.method(logger, 'warn', () => {});

    const answers = [
      await call('putTrackWork', { params: { id: '2001' }, body: fixture('work') }),
      await call('putTrackPhase', { params: { id: '3001' }, body: phaseRecord() }),
      await call('postTrackEvent', { body: fixture('event') })
    ].map(res => [res.statusCode, res.body.code]);

    assert.deepStrictEqual(answers, Array(3).fill([409, 'NOT_BACKFILLED']));
    assert.deepStrictEqual(store.writes, []);
  });

  await t.test('a body naming another record than the path answers 400 and writes nothing', async (t) => {
    const store = await seeded(t);
    t.mock.method(logger, 'error', () => {});

    const res = await call('putTrackPhase', { params: { id: '3002' }, body: phaseRecord() });

    assert.deepStrictEqual([res.statusCode, res.body.code], [400, 'RECORD_ID_MISMATCH']);
    assert.deepStrictEqual(store.writes, []);
  });

  await t.test('a work naming another project than the path answers 400', async (t) => {
    await seeded(t);
    t.mock.method(logger, 'error', () => {});

    const res = await call('putTrackWork', { params: { pid: '1002', id: '2001' }, body: fixture('work') });

    assert.deepStrictEqual([res.statusCode, res.body.code], [400, 'PROJECT_ID_MISMATCH']);
  });

  await t.test('a work type the nightly leaves out answers 200 skipped and writes nothing', async (t) => {
    const store = await seeded(t);
    const record = fixture('work');
    Object.assign(record, { workTypeId: 4 });

    const res = await call('putTrackWork', { params: { id: '2001' }, body: record });

    assert.deepStrictEqual(res.body, { id: '2001', action: 'skipped', reason: 'unmirrored' });
    assert.deepStrictEqual(store.writes, []);
  });

  await t.test('a new work without its phases list answers 400 rather than clearing the stored phases', async (t) => {
    const store = await seeded(t);
    t.mock.method(logger, 'error', () => {});
    const record = fixture('new_work');
    delete record.work.phases;

    const res = await call('postTrackWork', { body: record });

    assert.deepStrictEqual([res.statusCode, res.body.code], [400, 'PAYLOAD_INVALID']);
    assert.deepStrictEqual(store.writes, []);
  });

  await t.test('a phase with no work_id answers 400 PAYLOAD_INVALID, not a server fault', async (t) => {
    const store = await seeded(t);
    t.mock.method(logger, 'error', () => {});
    const record = phaseRecord();
    delete record.phase.work_id;

    const res = await call('postTrackPhase', { body: record });

    assert.deepStrictEqual([res.statusCode, res.body.code], [400, 'PAYLOAD_INVALID']);
    assert.deepStrictEqual(store.writes, []);
  });

  await t.test('a DELETE with no pushedAt answers 400: an empty value would read as 0', async (t) => {
    await seeded(t);
    t.mock.method(logger, 'error', () => {});

    const res = await call('deleteTrackEvent', { params: { id: '4001' }, query: { pushedAt: '', workTypeId: '6' } });

    assert.deepStrictEqual([res.statusCode, res.body.code], [400, 'PUSHED_AT_INVALID']);
  });

  await t.test('an event DELETE takes the milestone out of its work document', async (t) => {
    const store = await seeded(t);

    const res = await call('deleteTrackEvent', { params: { id: '4001' }, query: { pushedAt: String(LATER), workTypeId: '6' } });

    assert.strictEqual(res.statusCode, 200);
    const [doc] = store.rows('works');
    assert.deepStrictEqual(doc.phases[0].milestones.map(m => m.trackEventId), [4003]);
  });
});
