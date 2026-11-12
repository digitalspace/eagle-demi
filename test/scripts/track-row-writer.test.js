'use strict';

// The per-row writer through its two callers: the nightly's `syncProjects` and the push's
// `writeTrackProject`. Repositories are in-memory fakes; assertions are on what was written.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const { writeTrackProject } = require('../../src/scripts/sync-track-projects');
const { syncProjects } = require('../../src/scripts/sync-track-run');
const { deriveAssessments } = require('../../src/merge/assessments');
const phaseCatalog = require('../../src/domain/phase-catalog');
const config = require('../../src/config');
const { readForLevel } = require('../../src/helpers/access-sql');
const { workDocOf } = require('../../src/seed/track-mappers');
const { logger } = require('../../src/utils/logger');
const {
  NOW, API_PROJECT, storedProject, eagleOnlyProject, fakeLinks, fakeProjects, fakeWorks, useWorks
} = require('../helpers/track-sync-fakes');

const RENAMED = { ...API_PROJECT, name: 'Nicomen Wind Energy Project' };
const nestedWork = () => structuredClone(require('../fixtures/track-records/new_work_two_phases.json').work);

const flag = (t, name, value) => {
  const held = config[name];
  config[name] = value;
  t.after(() => { config[name] = held; });
};

const nightly = (projects, opts = {}) =>
  syncProjects([API_PROJECT], { live: true, deps: { projects, links: fakeLinks() }, now: NOW, ...opts });

test('the Track push', async (t) => {
  const PUSHED_AT = 1762650000000;
  const push = (projects, opts = {}) =>
    writeTrackProject(API_PROJECT, { phases: [], works: [], deps: { projects, links: fakeLinks() }, ...opts });
  const quiet = (t) => t.mock.method(logger, 'warn', () => {});

  await t.test('empty lists over a row holding none are no change', async () => {
    const projects = fakeProjects([storedProject()]);

    const result = await push(projects);

    assert.strictEqual(result.action, 'unchanged');
    assert.deepStrictEqual(projects.writes, []);
  });

  await t.test('a push older than the stored one is stale and writes nothing', async () => {
    const projects = fakeProjects([storedProject({ trackPushedAt: PUSHED_AT })]);

    const result = await writeTrackProject({ ...API_PROJECT, name: 'Renamed' },
      { phases: [], works: [], pushedAt: PUSHED_AT - 1, deps: { projects, links: fakeLinks() } });

    assert.strictEqual(result.action, 'stale');
    assert.deepStrictEqual(projects.writes, []);
  });

  await t.test('a push that writes stamps the row with its time', async () => {
    const projects = fakeProjects([storedProject({ trackPushedAt: PUSHED_AT })]);

    await writeTrackProject({ ...API_PROJECT, name: 'Renamed' },
      { phases: [], works: [], pushedAt: PUSHED_AT + 1, deps: { projects, links: fakeLinks() } });

    assert.strictEqual(projects.writes[0].trackPushedAt, PUSHED_AT + 1);
  });

  await t.test('a project naming a native project\'s Eagle id is skipped', async (t) => {
    const warn = quiet(t);
    const native = {
      id: '0f8fad5b-d9cb-469f-a165-70867728950e', trackProjectId: null, sourceSystem: 'demi',
      eagleId: API_PROJECT.epic_guid, sources: {}, read: readForLevel(1)
    };
    const projects = fakeProjects([native]);

    const result = await push(projects);

    assert.strictEqual(result.action, 'skipped');
    assert.strictEqual(result.reason, 'nativeClash');
    assert.deepStrictEqual(projects.writes, []);
    assert.ok(warn.mock.calls.some(c => /\[track-push\] project skipped/.test(c.arguments[0])));
  });

  await t.test('a row created through POST /projects is skipped', async (t) => {
    quiet(t);
    const projects = fakeProjects([storedProject({ sources: {} })]);

    const result = await push(projects);

    assert.strictEqual(result.reason, 'apiRow');
    assert.deepStrictEqual(projects.writes, []);
  });

  await t.test('an Eagle-only twin is re-keyed and hands its ownership to the Track row', async () => {
    const projects = fakeProjects([eagleOnlyProject({ demiOwnedAt: NOW, syncVersion: 3 })]);

    const result = await push(projects, { pushedAt: PUSHED_AT });

    assert.strictEqual(result.action, 'relinked');
    const row = projects.items.find(p => p.id === '207');
    assert.deepStrictEqual(row.read, readForLevel(4), 'a re-key must not move a level');
    assert.strictEqual(row.trackPushedAt, PUSHED_AT);
    const twin = projects.items.find(p => p.id === `eagle-${API_PROJECT.epic_guid}`);
    assert.strictEqual(Object.hasOwn(twin, 'demiOwnedAt'), false);
  });
});

test('a run against a push stamp', async (t) => {
  await t.test('a row a newer push wrote is left alone and counted stale', async () => {
    const projects = fakeProjects([storedProject({ trackPushedAt: Date.now() + 60000 })]);

    const summary = await syncProjects([RENAMED],
      { live: true, deps: { projects, links: fakeLinks() }, now: NOW, pushedAt: Date.now() });

    assert.deepStrictEqual(projects.writes, []);
    assert.deepStrictEqual([summary.updated, summary.stale], [0, 1]);
  });

  await t.test('a run writes no push stamp', async () => {
    const projects = fakeProjects([storedProject()]);

    await syncProjects([RENAMED], { live: true, deps: { projects, links: fakeLinks() }, now: NOW, pushedAt: Date.now() });

    assert.ok(!('trackPushedAt' in projects.writes[0]));
  });

  await t.test('a push older than the run still lands on a row the run wrote', async () => {
    const projects = fakeProjects([storedProject()]);
    const pushedAt = Date.now() - 60000;
    await syncProjects([RENAMED], { live: true, deps: { projects, links: fakeLinks() }, now: NOW, pushedAt: Date.now() });

    const result = await writeTrackProject({ ...API_PROJECT, name: 'Pushed name' },
      { phases: [], works: [], pushedAt, deps: { projects, links: fakeLinks() } });

    assert.strictEqual(result.action, 'updated');
    assert.strictEqual(projects.writes.at(-1).name, 'Pushed name');
  });
});

test('the works dual write', async (t) => {
  const nested = () => new Map([['207', [nestedWork()]]]);

  await t.test('with WORKS_WRITE on, a nightly saves each mirrored work and still writes the row arrays', async (t) => {
    flag(t, 'worksWrite', true);
    const works = useWorks(t, fakeWorks());
    const projects = fakeProjects([storedProject()]);
    const rowWorks = [{ trackWorkId: 2001, workTypeId: 6, phases: [], milestones: [] }];

    await nightly(projects, { nested: nested(), works: new Map([['207', rowWorks]]) });

    assert.deepStrictEqual(works.saved.map(doc => doc.id), ['track-2001']);
    assert.deepStrictEqual(projects.writes[0].works, rowWorks);
  });

  await t.test('with WORKS_WRITE off, the container is never called and the row writes as before', async (t) => {
    flag(t, 'worksWrite', false);
    const works = useWorks(t, fakeWorks());
    const withNested = fakeProjects([storedProject()]);
    const without = fakeProjects([storedProject()]);

    await syncProjects([RENAMED], { live: true, deps: { projects: withNested, links: fakeLinks() }, now: NOW, nested: nested() });
    await syncProjects([RENAMED], { live: true, deps: { projects: without, links: fakeLinks() }, now: NOW });

    assert.deepStrictEqual(works.calls, []);
    assert.deepStrictEqual(withNested.writes, without.writes);
  });

  await t.test('a Track id held by an API row gets no work document', async (t) => {
    flag(t, 'worksWrite', true);
    t.mock.method(logger, 'warn', () => {});
    const works = useWorks(t, fakeWorks());

    await nightly(fakeProjects([storedProject({ sources: {} })]), { nested: nested() });

    assert.deepStrictEqual(works.calls, []);
  });
});

test('derived values repaired from the works container', async (t) => {
  // The stored row as the nightly last derived it from its own empty `works`.
  const settled = () => {
    const row = storedProject();
    return { ...row, ...deriveAssessments(row) };
  };
  const readOn = (t, docs) => {
    flag(t, 'worksRead', true);
    t.mock.method(phaseCatalog, 'load', async () => ({}));
    return useWorks(t, fakeWorks(docs));
  };

  await t.test('a row whose works derive other values is rewritten and counted as drift', async (t) => {
    readOn(t, [workDocOf(nestedWork(), { projectId: '207' })]);
    const projects = fakeProjects([settled()]);

    const summary = await nightly(projects);

    assert.deepStrictEqual([summary.derivedDrift, summary.updated], [1, 0]);
    assert.notDeepStrictEqual(projects.writes[0].assessments, settled().assessments);
  });

  await t.test('a row Track moved counts as an update, not as drift', async (t) => {
    readOn(t, [workDocOf(nestedWork(), { projectId: '207' })]);
    const projects = fakeProjects([settled()]);

    const summary = await syncProjects([RENAMED], { live: true, deps: { projects, links: fakeLinks() }, now: NOW });

    assert.deepStrictEqual([summary.derivedDrift, summary.updated], [0, 1]);
  });

  await t.test('a row the works agree with is not written', async (t) => {
    readOn(t, []);
    const projects = fakeProjects([settled()]);

    const summary = await nightly(projects);

    assert.strictEqual(summary.derivedDrift, 0);
    assert.deepStrictEqual(projects.writes, []);
  });
});

test('the row writer and the run load in either order', () => {
  const root = path.join(__dirname, '..', '..');
  const probe = (first, second) => execFileSync(process.execPath, ['-e', `
    require('./src/scripts/${first}'); require('./src/scripts/${second}');
    require('./src/scripts/sync-track-run')
      .syncProjects([], { deps: { projects: { listVisible: async () => ({ items: [] }) } } })
      .then(s => process.stdout.write(String(s.trackProjects)));
  `], { cwd: root, env: { ...process.env, NODE_ENV: 'test' }, encoding: 'utf8' });

  assert.strictEqual(probe('sync-track-run', 'sync-track-projects'), '0');
  assert.strictEqual(probe('sync-track-projects', 'sync-track-run'), '0');
});
