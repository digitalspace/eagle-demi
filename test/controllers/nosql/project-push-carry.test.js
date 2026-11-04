'use strict';

// A push carries no Track works, so the row it rebuilds takes them back off the stored row, or
// every Eagle save would erase what the nightly sync wrote until the next run.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const projects = require('../../../src/repositories/projects');
const projectController = require('../../../src/controllers/nosql/project');
const syncOut = require('../../../src/sync-out');
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

test('PUT /eagle/projects/:eagleId on a project DEMI owns', async (t) => {
  t.beforeEach(() => projectReadForWriteFromGet(t));
  t.afterEach(() => t.mock.restoreAll());

  const owned = () => storedEagleProject({
    demiOwnedAt: '2026-11-01T00:00:00.000Z', legislationYear: 2002, legislationYearList: [2002],
    currentLegislationYear: 'legislation_2002', legislation_2002: { name: 'Nicomen Wind Energy', legislationYear: 2002 }
  });

  async function pushOver(existing, doc) {
    t.mock.method(projects, 'getByEagleId', async () => structuredClone(existing));
    let written;
    t.mock.method(projects, 'upsert', async (item) => { written = item; return item; });
    const res = mockRes();
    await projectController.upsertFromEagle({
      params: { eagleId: PROJECT_EAGLE_ID }, query: {}, user: STAFF, body: { doc: eagleProject(doc) }
    }, res);
    return { res, written };
  }

  await t.test("Eagle's delete leaves it live at its own level", async () => {
    const { res, written } = await pushOver(owned(), { isDeleted: true });

    assert.strictEqual(res.statusCode, 200);
    assert.ok(!('isDeleted' in written));
    assert.ok(written.read.includes('public'), JSON.stringify(written.read));
  });

  await t.test("Eagle's year change leaves it under its own year", async () => {
    const { written } = await pushOver(owned(), {
      currentLegislationYear: 'legislation_2018', legislationYearList: [2002, 2018],
      legislation_2018: { name: 'Nicomen Wind Energy', legislationYear: 2018, region: 'Thompson-Nicola' }
    });

    assert.deepStrictEqual([written.legislationYear, written.currentLegislationYear], [2002, 'legislation_2002']);
    assert.deepStrictEqual(written.legislationYearList, [2002]);
    assert.ok(!('legislation_2018' in written));
    assert.ok(!('region' in written), 'a field DEMI does not hold is not taken from Eagle');
  });
});

test('a DEMI PUT on an Eagle project', async (t) => {
  t.beforeEach(() => projectReadForWriteFromGet(t));
  t.afterEach(() => t.mock.restoreAll());

  /** One stored row that the PUT and the push both read and write; `queued` is what sync-out was handed. */
  function store(t, row) {
    const state = { row, queued: [] };
    const read = async () => structuredClone(state.row);
    t.mock.method(projects, 'getById', read);
    t.mock.method(projects, 'getByEagleId', read);
    t.mock.method(projects, 'readForWrite', async () => null);
    t.mock.method(projects, 'upsert', async (item) => { state.row = item; return item; });
    t.mock.method(syncOut, 'enqueue', async (item, options) => { state.queued.push({ item, options }); return ['eagle']; });
    return state;
  }

  async function put(body, id = '207') {
    const res = mockRes();
    await projectController.updateProject({ params: { id }, query: {}, user: STAFF, body }, res);
    return res;
  }

  const TWIN_ID = `eagle-${PROJECT_EAGLE_ID}`;
  /** The row Eagle alone gave DEMI: no Track source, so its name and the like come from Eagle. */
  const eagleOnly = () => ({
    id: TWIN_ID, eagleId: PROJECT_EAGLE_ID, sourceSystem: 'eagle', name: 'Nicomen Wind Energy',
    read: ['public', 'staff'], isPublished: true, sources: { eagle: { _id: PROJECT_EAGLE_ID, name: 'Nicomen Wind Energy' } }
  });

  await t.test("of sector, then an Eagle push with another sector, keeps DEMI's", async () => {
    const state = store(t, storedEagleProject({ sector: 'Energy' }));

    await put({ sector: 'Mining' });
    const res = mockRes();
    await projectController.upsertFromEagle({
      params: { eagleId: PROJECT_EAGLE_ID }, query: {}, user: STAFF, body: { doc: eagleProject({ sector: 'Transportation' }) }
    }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(state.row.sector, 'Mining');
  });

  await t.test('of an Eagle field bumps syncVersion and queues the project', async () => {
    const state = store(t, storedEagleProject({ syncVersion: 2 }));

    await put({ sector: 'Mining' });

    assert.strictEqual(state.row.syncVersion, 3);
    assert.deepStrictEqual(state.queued.map(q => [q.item.id, q.options.kind]), [['207', 'project']]);
  });

  await t.test('of a Track field leaves the project Eagle\'s', async () => {
    const state = store(t, storedEagleProject({ syncVersion: 2 }));

    await put({ name: 'Renamed' });

    assert.ok(!('demiOwnedAt' in state.row));
    assert.strictEqual(state.row.syncVersion, 2);
    assert.deepStrictEqual(state.queued, []);
  });

  await t.test('echoing an unchanged Eagle field leaves the project Eagle\'s', async () => {
    const state = store(t, storedEagleProject({ sector: 'Energy' }));

    await put({ sector: 'Energy', name: 'Renamed' });

    assert.ok(!('demiOwnedAt' in state.row));
  });

  await t.test('of name on a project only Eagle has takes it over', async () => {
    const state = store(t, eagleOnly());

    await put({ name: 'Nicomen Wind' }, TWIN_ID);
    await projectController.upsertFromEagle({
      params: { eagleId: PROJECT_EAGLE_ID }, query: {}, user: STAFF, body: { doc: eagleProject() }
    }, mockRes());

    assert.strictEqual(state.row.name, 'Nicomen Wind');
  });

  await t.test('on the Eagle-only twin beside a Track row leaves the twin Eagle\'s', async () => {
    const state = store(t, eagleOnly());
    t.mock.method(projects, 'readForWriteByEagleId', async () => storedEagleProject());

    await put({ sector: 'Mining' }, TWIN_ID);

    assert.strictEqual(state.row.sector, 'Mining');
    assert.ok(!('demiOwnedAt' in state.row), 'sync-out would send both rows to one Eagle project');
  });

  await t.test('on a row with no Eagle copy leaves it untaken: sync-out would send blanks over Eagle', async () => {
    const stored = storedEagleProject();
    delete stored.sources.eagle;
    const state = store(t, stored);

    await put({ sector: 'Mining' });

    assert.ok(!('demiOwnedAt' in state.row));
  });

  await t.test('that re-points eagleId answers 409 and writes nothing', async () => {
    const state = store(t, storedEagleProject());

    const res = await put({ eagleId: 'aaaaaaaaaaaaaaaaaaaaaaaa', sector: 'Mining' });

    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(state.row.eagleId, PROJECT_EAGLE_ID);
  });

  await t.test('of tags alone on a taken-over project queues nothing', async () => {
    const state = store(t, storedEagleProject({ demiOwnedAt: '2026-11-01T00:00:00.000Z', syncVersion: 2 }));

    await put({ tags: ['wind'] });

    assert.deepStrictEqual(state.row.tags, ['wind']);
    assert.strictEqual(state.row.syncVersion, 2);
    assert.deepStrictEqual(state.queued, []);
  });
});
