'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const config = require('../../src/config');
const cosmos = require('../../src/db/cosmos-nosql');
const works = require('../../src/repositories/works');
const { run, trackParity } = require('../../src/scripts/check-works-parity');
const { logger } = require('../../src/utils/logger');
const { trackWorks, storedRow, workDocs, worksContainer } = require('../helpers/track-works-fixtures');
const { mirrorStore } = require('../helpers/mirror-store');

const SHEET_WORK = { id: 'sheet-00000000-0000-4000-8000-000000000001', projectId: '207', source: 'sheet',
  workTypeCode: 'assessment', workType: 'Assessment', actYear: 2002, startDate: '2003-02-01', phases: [] };

/** The rows the run lists: project 207 with its Track works, and an Eagle-only row with none. */
const projectsOf = () => ({ listVisible: async () => ({ items: [storedRow(), { id: 'eagle-1', read: ['staff'] }] }) });

function logged(t) {
  const lines = [];
  for (const level of ['info', 'warn', 'error']) t.mock.method(logger, level, (msg) => { lines.push(msg); });
  return lines;
}

test('check-works-parity', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('rows whose works the container composes the same pass with storedMismatch=0', async () => {
    // A sheet work is composed in but was never in the row's Track copy.
    worksContainer(t, [[...workDocs(), SHEET_WORK]]);
    const lines = logged(t);

    const code = await run({ projects: projectsOf(), workProjectIds: async () => ['207', '207'] });

    assert.strictEqual(code, 0);
    assert.deepStrictEqual(lines, ['[works-parity] projects=1 failures=0 storedMismatch=0 orphaned=0']);
  });

  await t.test('parity storedMismatch counts a stored works copy that differs from the composed works', async () => {
    const moved = trackWorks();
    moved[1].work_state = 'IN_PROGRESS';
    worksContainer(t, [workDocs(moved)]);
    const lines = logged(t);

    const code = await run({ projects: projectsOf(), workProjectIds: async () => [] });

    assert.strictEqual(code, 1);
    assert.deepStrictEqual(lines, ['[works-parity] storedMismatch id=207',
      '[works-parity] projects=1 failures=0 storedMismatch=1 orphaned=0']);
  });

  await t.test('a live work whose project has no row counts as orphaned and does not fail the run', async () => {
    worksContainer(t, [workDocs()]);
    const lines = logged(t);

    const code = await run({ projects: projectsOf(), workProjectIds: async () => ['207', 'gone-1', 'gone-1'] });

    assert.strictEqual(code, 0);
    assert.deepStrictEqual(lines, ['[works-parity] projects=1 failures=0 storedMismatch=0 orphaned=2']);
  });

  await t.test('liveProjectIds reads only projectId of live works, marker left out, owner filter kept', async () => {
    mirrorStore(t, [
      { id: 'track-1', projectId: 'p1', source: 'track', owner: 'track' },
      { id: 'track-2', projectId: 'p2' },
      { id: 'track-3', projectId: 'p3', deleted: true },
      { id: 'sheet-override', projectId: 'p1', kind: 'override', source: 'sheet', owner: 'sheet' },
      { ...SHEET_WORK, projectId: 'p4', owner: 'sheet' }
    ].map(row => ({ container: 'works', ...row })));
    const query = cosmos.query;
    const projections = [];
    // The fake runs the WHERE clause on whole rows; the projection is checked here and applied after it.
    t.mock.method(cosmos, 'query', async (container, spec, opts) => {
      const [projection] = spec.query.match(/^SELECT VALUE c\.projectId FROM c WHERE /) || [];
      projections.push(projection);
      const page = await query(container, { ...spec, query: spec.query.replace(projection, 'SELECT * FROM c WHERE ') }, opts);
      return { ...page, items: page.items.map(row => row.projectId) };
    });

    const all = await works.liveProjectIds();
    const track = await works.liveProjectIds({ owner: 'track' });

    assert.deepStrictEqual([all.sort(), track.sort()], [['p1', 'p2', 'p4'], ['p1', 'p2']]);
    assert.ok(projections.every(Boolean), 'SELECT VALUE c.projectId only');
  });
});

test('nightly works parity', async (t) => {
  const held = { trackWorksSync: config.trackWorksSync, worksWrite: config.worksWrite };
  Object.assign(config, { trackWorksSync: true, worksWrite: true });
  t.after(() => Object.assign(config, held));
  t.afterEach(() => t.mock.restoreAll());

  const PROJECT_207 = { id: 207, name: 'Nicomen Wind Energy' };
  const LIVE = { live: true };
  /** `fetchTrackWorks`' answer holding project 207; {stats} as the pull counted them. */
  const pullOf = (stats = {}) => ({ nested: new Map([['207', trackWorks()]]),
    stats: { failures: 0, budgetHit: false, ...stats } });
  const container = (byProject, known = Object.keys(byProject)) => {
    t.mock.method(works, 'liveProjectIds', async () => known);
    return t.mock.method(works, 'listForRead', async (id) => byProject[id] || []);
  };
  const counted = (over) => ({ trackMismatch: 0, projects: 0, skipped: 0, absentFromPull: 0, notWritten: 0, ...over });

  await t.test('nightly skips a project missing from the pull and counts it as skipped, not as a mismatch', async () => {
    const reads = container({ 207: workDocs() }, ['207', '300']);

    const afterFailure = await trackParity([PROJECT_207], pullOf({ failures: 1 }), LIVE);
    const afterBudget = await trackParity([PROJECT_207], pullOf({ budgetHit: true }), LIVE);
    const clean = await trackParity([PROJECT_207], pullOf(), LIVE);

    assert.deepStrictEqual([afterFailure, afterBudget, clean],
      [counted({ projects: 1, skipped: 1 }), counted({ projects: 1, skipped: 1 }), counted({ projects: 1, absentFromPull: 1 })]);
    assert.deepStrictEqual(reads.mock.calls.map(call => call.arguments[0]), ['207', '207', '207'], 'only pulled projects read');
  });

  await t.test('a pulled project the mirror wrote no work for counts as notWritten, not as a mismatch', async () => {
    container({});

    assert.deepStrictEqual(await trackParity([PROJECT_207], pullOf(), LIVE), counted({ notWritten: 1 }));
  });

  await t.test('nightly parity reads the container through listForRead', async () => {
    const reads = container({ 207: workDocs() });
    const full = t.mock.method(works, 'listByProject', async () => []);

    const counts = await trackParity([PROJECT_207], pullOf(), LIVE);

    assert.deepStrictEqual([counts.trackMismatch, reads.mock.callCount(), full.mock.callCount()], [0, 1, 0]);
  });

  await t.test('parity ignores a non-Track work', async () => {
    container({ 207: [...workDocs(), { ...SHEET_WORK, owner: 'sheet' }] });

    assert.deepStrictEqual(await trackParity([PROJECT_207], pullOf(), LIVE), counted({ projects: 1 }));
  });

  await t.test('parity compares suspension and the Track phase and event ids', async () => {
    const suspended = workDocs();
    suspended[0].phases[1].isSuspended = true;
    container({ 207: suspended });

    assert.deepStrictEqual(await trackParity([PROJECT_207], pullOf(), LIVE), counted({ projects: 1, trackMismatch: 1 }));
  });

  await t.test('a failed container read is skipped once and the next project is still compared', async () => {
    container({ 207: workDocs() });
    const reads = t.mock.method(works, 'listForRead', async (id) => {
      if (id === '300') throw new Error('cosmos said no');
      return workDocs();
    });
    const pull = pullOf();
    pull.nested.set('300', trackWorks());

    const counts = await trackParity([PROJECT_207, { id: 300, name: 'Nicomen Wind Energy' }], pull, LIVE);

    assert.deepStrictEqual([counts, reads.mock.callCount()], [counted({ projects: 1, skipped: 1 }), 2]);
  });

  await t.test('parity runs only on a live night with WORKS_WRITE and TRACK_WORKS_SYNC on', async () => {
    const reads = container({ 207: workDocs() });
    const answers = [await trackParity([PROJECT_207], pullOf(), { live: false })];
    for (const off of [{ worksWrite: false }, { trackWorksSync: false }]) {
      Object.assign(config, off);
      answers.push(await trackParity([PROJECT_207], pullOf(), LIVE));
      Object.assign(config, { trackWorksSync: true, worksWrite: true });
    }

    assert.deepStrictEqual([answers, reads.mock.callCount()], [[null, null, null], 0]);
  });
});
