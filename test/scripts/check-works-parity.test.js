'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const config = require('../../src/config');
const works = require('../../src/repositories/works');
const { run, trackParity } = require('../../src/scripts/check-works-parity');
const { logger } = require('../../src/utils/logger');
const { trackWorks, storedRow, workDocs, worksContainer } = require('../helpers/track-works-fixtures');

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
    worksContainer(t, [workDocs()]);
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
  /** {byProject} as `listForRead` reads it; `listByProject` with tombstones answers {every}, else the same. */
  const container = (byProject, { known = Object.keys(byProject), every = byProject } = {}) => {
    t.mock.method(works, 'liveProjectIds', async () => known);
    t.mock.method(works, 'listByProject', async (id) => every[id] || []);
    return t.mock.method(works, 'listForRead', async (id) => byProject[id] || []);
  };
  const counted = (over) => ({ trackMismatch: 0, projects: 0, skipped: 0, absentFromPull: 0, notWritten: 0, ...over });
  const adoptedCopy = (doc) => ({ ...doc, source: 'track', owner: 'sheet' });

  await t.test('nightly skips a project missing from the pull and counts it as skipped, not as a mismatch', async () => {
    const reads = container({ 207: workDocs() }, { known: ['207', '300'] });

    const afterFailure = await trackParity([PROJECT_207], pullOf({ failures: 1 }), LIVE);
    const afterBudget = await trackParity([PROJECT_207], pullOf({ budgetHit: true }), LIVE);
    const clean = await trackParity([PROJECT_207], pullOf(), LIVE);

    assert.deepStrictEqual([afterFailure, afterBudget, clean],
      [counted({ projects: 1, skipped: 1 }), counted({ projects: 1, skipped: 1 }), counted({ projects: 1, absentFromPull: 1 })]);
    assert.deepStrictEqual(reads.mock.calls.map(call => call.arguments[0]), ['207', '207', '207'], 'only pulled projects read');
  });

  await t.test('a listed pulled project with an empty container is a mismatch unless the mirror skipped one', async () => {
    container({});

    const unexplained = await trackParity([PROJECT_207], pullOf(), LIVE);
    const clash = await trackParity([PROJECT_207], pullOf(), { ...LIVE, mirrored: { nativeClash: 1 } });
    const apiRow = await trackParity([PROJECT_207], pullOf(), { ...LIVE, mirrored: { skippedApiRows: 1 } });
    const unlisted = await trackParity([], pullOf(), LIVE);

    assert.deepStrictEqual([unexplained, clash, apiRow, unlisted], [counted({ projects: 1, trackMismatch: 1 }),
      counted({ notWritten: 1 }), counted({ notWritten: 1 }), counted({ notWritten: 1 })]);
  });

  await t.test('a pulled project whose only works were adopted counts as the same, not as empty', async () => {
    const adopted = workDocs().map(adoptedCopy);
    container({ 207: adopted });

    assert.deepStrictEqual(await trackParity([PROJECT_207], pullOf(), LIVE), counted({ projects: 1 }));
  });

  await t.test('an adopted Track work, tombstoned or not, is left out of the pulled side', async () => {
    const [assessment, exemption] = workDocs();
    const tombstoned = { ...adoptedCopy(exemption), deleted: true };
    container({ 207: [assessment] }, { every: { 207: [assessment, tombstoned] } });

    assert.deepStrictEqual(await trackParity([PROJECT_207], pullOf(), LIVE), counted({ projects: 1 }));
  });

  await t.test('a project a push wrote after the pull began is skipped', async () => {
    const pushed = workDocs();
    pushed[0].pushStamps = { work: 2000 };
    pushed[0].isActive = false;
    container({ 207: pushed });

    assert.deepStrictEqual(await trackParity([PROJECT_207], pullOf(), { ...LIVE, pushedAt: 1000 }), counted({ skipped: 1 }));
  });

  await t.test('nightly parity reads the container through listForRead', async () => {
    const moved = workDocs();
    moved[0].isActive = false;
    const reads = container({ 207: workDocs() }, { every: { 207: moved } });

    const counts = await trackParity([PROJECT_207], pullOf(), LIVE);

    assert.deepStrictEqual([counts.trackMismatch, reads.mock.callCount()], [0, 1]);
  });

  await t.test('parity ignores a non-Track work', async () => {
    container({ 207: [...workDocs(), { ...SHEET_WORK, owner: 'sheet' }] });

    assert.deepStrictEqual(await trackParity([PROJECT_207], pullOf(), LIVE), counted({ projects: 1 }));
  });

  await t.test('parity compares a phase\'s suspension', async () => {
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
