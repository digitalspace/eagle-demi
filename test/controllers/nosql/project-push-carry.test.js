'use strict';

// A push carries no Track works, so the row it rebuilds takes them back off the stored row, or
// every Eagle save would erase what the nightly sync wrote until the next run.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const projects = require('../../../src/repositories/projects');
const projectController = require('../../../src/controllers/nosql/project');
const {
  mockRes, STAFF, PROJECT_EAGLE_ID, eagleProject, storedEagleProject, projectReadForWriteFromGet
} = require('../../helpers/eagle-mirror-fixtures');
const { trackWorks, TRANSITION_DATE } = require('../../fixtures/track-works-contract');

test('PUT /eagle/projects/:eagleId keeps the stored Track works', async (t) => {
  t.beforeEach(() => projectReadForWriteFromGet(t));
  t.afterEach(() => t.mock.restoreAll());

  /** Push an Eagle record that moved from the 2002 Act to 2018 over `existing`; return the write. */
  async function pushOver(existing) {
    t.mock.method(projects, 'getByEagleId', async () => structuredClone(existing));
    let written;
    t.mock.method(projects, 'upsert', async (item) => { written = item; return item; });

    const res = mockRes();
    await projectController.upsertFromEagle({
      params: { eagleId: PROJECT_EAGLE_ID }, query: {}, user: STAFF,
      body: { doc: eagleProject({ legislationYearList: [2002, 2018] }) }
    }, res);
    return { res, written };
  }

  await t.test('works stay and the transitions are rebuilt with the milestone date', async () => {
    const { res, written } = await pushOver(storedEagleProject({
      works: trackWorks(),
      legislationTransitions: [{ fromYear: 2002, toYear: 2018, date: null }]
    }));

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(written.id, '207', 'the premise: the Track-matched merge ran');
    assert.deepStrictEqual(written.works, trackWorks());
    assert.deepStrictEqual(written.legislationTransitions,
      [{ fromYear: 2002, toYear: 2018, date: TRANSITION_DATE }]);
  });

  await t.test('a row the works sync never reached gets neither key', async () => {
    const { res, written } = await pushOver(storedEagleProject());

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(written.id, '207', 'the premise: the Track-matched merge ran');
    assert.ok(!('works' in written));
    assert.ok(!('legislationTransitions' in written));
  });
});
