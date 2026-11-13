'use strict';

/** The project read and the project writes with WORKS_READ on: works come from the `works` container. */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const config = require('../../../src/config');
const projects = require('../../../src/repositories/projects');
const documents = require('../../../src/repositories/documents');
const commentPeriods = require('../../../src/repositories/comment-periods');
const aiSearch = require('../../../src/search/ai-search');
const projectController = require('../../../src/controllers/nosql/project');
const { composedRow } = require('../../../src/controllers/nosql/project-compose');
const { ASSESSMENT_WORK_TYPE } = require('../../../src/merge/assessment-work');
const { withoutAdded } = require('../../../src/scripts/check-works-parity');
const { logger } = require('../../../src/utils/logger');
const { mockRes, STAFF, PROJECT_EAGLE_ID } = require('../../helpers/eagle-mirror-fixtures');
const { trackWorks, eagleDoc, storedRow, workDocs, worksContainer } = require('../../helpers/track-works-fixtures');

function quietCascade(t) {
  t.mock.method(aiSearch, 'writeAcls', async (_index, rows) => rows.length);
  t.mock.method(documents, 'setAclForProject', async () => ({ succeeded: 0, failed: 0, rows: [] }));
  t.mock.method(commentPeriods, 'setAclForProject', async () => ({ succeeded: 0, failed: 0, rows: [] }));
}

const get = async (user) => {
  const res = mockRes();
  await projectController.getProject({ params: { id: '207' }, query: {}, user }, res);
  return res;
};

const push = async () => {
  const res = mockRes();
  await projectController.upsertFromEagle({
    params: { eagleId: PROJECT_EAGLE_ID }, query: {}, user: STAFF, body: { doc: eagleDoc(), pushedAt: Date.now() }
  }, res);
  return res;
};

test('project reads and writes with WORKS_READ on', async (t) => {
  const worksRead = config.worksRead;
  t.afterEach(() => {
    config.worksRead = worksRead;
    t.mock.restoreAll();
  });

  await t.test('the composed GET equals the row GET but for the keys the container adds', async () => {
    worksContainer(t, [workDocs()]);
    const row = storedRow();
    t.mock.method(projects, 'getById', async () => structuredClone(row));

    config.worksRead = false;
    const off = await get(STAFF);
    config.worksRead = true;
    const on = await get(STAFF);

    assert.strictEqual(on.body.works[0].phases[0].trackPhaseId, 501, 'the flag-on body came from the container');
    assert.deepStrictEqual(withoutAdded(on.body), withoutAdded(off.body));
  });

  await t.test('a phase starting after today is planned at both ends; a completed one at neither', async () => {
    config.worksRead = true;
    worksContainer(t, [workDocs()]);
    t.mock.method(projects, 'getById', async () => storedRow({ bare: true }));

    const { body } = await get(STAFF);

    assert.deepStrictEqual(body.phases.map(p => [p.name, p.startPlanned, p.endPlanned]),
      [['Early Engagement', false, false], ['Readiness Decision', true, true]]);
  });

  await t.test('works with no Assessment work leave the stored phases', () => {
    const row = { id: '207', phases: [{ name: 'Stored' }] };

    const composed = composedRow(row, [{ trackWorkId: 40, workTypeId: 5, phases: [] }]);

    assert.deepStrictEqual(composed.phases, row.phases);
  });

  await t.test('Eagle-only row keeps its phases', () => {
    const row = { id: '207', phases: [{ name: 'Stored' }] };
    const sheet = { workId: 'sheet-1', source: 'sheet', workTypeCode: 'assessment', phases: [{ name: 'Pre-Application' }] };

    const composed = composedRow(row, [sheet]);

    assert.deepStrictEqual(composed.phases, row.phases);
  });

  await t.test('an Assessment work with no phases leaves the stored phases', () => {
    const row = { id: '207', phases: [{ name: 'Stored' }] };

    const composed = composedRow(row, [{ trackWorkId: 31, workTypeId: ASSESSMENT_WORK_TYPE, phases: [] }]);

    assert.deepStrictEqual(composed.phases, row.phases);
  });

  await t.test('an anonymous read of a row whose works dial is below public gets no works', async () => {
    config.worksRead = true;
    worksContainer(t, [workDocs()]);
    t.mock.method(projects, 'getById', async () => ({ ...storedRow({ bare: true }), vis: { works: 2 } }));

    const res = await get(undefined);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.works, undefined);
  });

  await t.test('an Eagle push keeps the Track-derived fields when only the container holds works', async () => {
    config.worksRead = true;
    worksContainer(t, [workDocs()]);
    quietCascade(t);
    t.mock.method(projects, 'readForWriteByEagleId', async () => storedRow({ bare: true }));
    const writes = [];
    t.mock.method(projects, 'upsert', async (item) => { writes.push(item); return item; });

    const res = await push();

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(writes[0].legislationTransitions, [{ fromYear: 2002, toYear: 2018, date: '2025-01-10T00:00:00.000Z' }]);
    assert.deepStrictEqual(writes[0].assessments.find(a => a.legislationYear === 2018).phases
      .filter(p => p.source === 'track').map(p => p.name), ['Early Engagement', 'Readiness Decision']);
    assert.strictEqual(writes[0].activeWork.trackWorkId, 31);
  });

  await t.test('an Eagle push that loses its write race reads the works again', async () => {
    config.worksRead = true;
    const closed = trackWorks();
    closed[0].is_active = false;
    worksContainer(t, [workDocs(closed), workDocs()]);
    quietCascade(t);
    t.mock.method(logger, 'warn', () => {});
    t.mock.method(projects, 'readForWriteByEagleId', async () => storedRow({ bare: true }));
    const writes = [];
    t.mock.method(projects, 'upsert', async (item) => {
      writes.push(item);
      if (writes.length === 1) throw Object.assign(new Error('lost its etag race'), { code: 412 });
      return item;
    });

    await push();

    assert.deepStrictEqual(writes.map(w => w.activeWork && w.activeWork.trackWorkId), [null, 31]);
  });

  await t.test('a staff save derives the Track fields from the container', async () => {
    config.worksRead = true;
    worksContainer(t, [workDocs()]);
    quietCascade(t);
    t.mock.method(projects, 'getById', async () => storedRow({ bare: true }));
    const writes = [];
    t.mock.method(projects, 'upsert', async (item) => { writes.push(item); return item; });

    const res = mockRes();
    await projectController.updateProject({ params: { id: '207' }, query: {}, user: STAFF, body: { description: 'Edited' } }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(writes[0].activeWork.trackWorkId, 31);
  });

  await t.test('a level switch to another Act keeps the Track-derived fields when only the container holds works', async () => {
    config.worksRead = true;
    worksContainer(t, [workDocs()]);
    quietCascade(t);
    t.mock.method(projects, 'getById', async () => storedRow({ bare: true }));
    const writes = [];
    t.mock.method(projects, 'upsert', async (item) => { writes.push(item); return item; });

    const res = mockRes();
    await projectController.setLevel({
      params: { id: '207' }, query: {}, user: STAFF,
      body: { level: 4, confirm: true, reason: 'switch Act', legislationYear: 2018 }
    }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(writes[0].legislationYear, 2018);
    assert.strictEqual(writes[0].legislationTransitions.length, 1);
    assert.strictEqual(writes[0].legislationTransitions[0].date, '2025-01-10T00:00:00.000Z');
    assert.deepStrictEqual(writes[0].assessments.find(a => a.legislationYear === 2018).phases
      .filter(p => p.source === 'track').map(p => p.name), ['Early Engagement', 'Readiness Decision']);
    assert.strictEqual(writes[0].activeWork.trackWorkId, 31);
  });
});
