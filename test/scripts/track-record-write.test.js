'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const config = require('../../src/config');
const lists = require('../../src/repositories/lists');
const { logger } = require('../../src/utils/logger');
const { mirrorStore } = require('../helpers/mirror-store');
const { writeTrackRecord } = require('../../src/scripts/track-record-write');

const PROJECT = '1001';
const LATER = 1762675200000 + 1000;
const TRANSITION = 'Project Transitioning FROM the EA Act (2002)';
const DERIVED_PATHS = ['/legislationTransitions', '/assessments', '/phaseIds', '/activeWork'];

const fixture = (name) => structuredClone(require(`../fixtures/track-records/${name}.json`));

const row = () => ({ container: 'projects', id: PROJECT, name: 'North Pit', read: ['public'], legislationYearList: [2002, 2018] });

/** The transition milestone (named by its configuration) on the fixture work's phase, dated `actual`. */
function transitionEvent(actual) {
  const { event } = fixture('event');
  return { pushedAt: LATER, workTypeId: 6, event: { ...event, id: 4100, actual_date: actual,
    event_configuration: { ...event.event_configuration, name: TRANSITION } } };
}

const writesTo = (store, container) => store.writes.filter(w => w.container === container);
const storedRow = (store) => store.rows('projects').find(r => r.id === PROJECT);
const storedWork = (store) => store.rows('works').find(r => r.id === 'track-2001');

/** Flags on, the fixture work stored and the row settled from it; `writes` emptied after. */
async function seeded(t, { worksRead = true, rows = [row()] } = {}) {
  const flags = { worksWrite: config.worksWrite, worksRead: config.worksRead };
  t.after(() => Object.assign(config, flags));
  Object.assign(config, { worksWrite: true, worksRead });
  t.mock.method(lists, 'readCatalog', async () => null);
  const store = mirrorStore(t, rows);
  // mirrorStore keys `works` by id alone; a point read there passes the partition too.
  const read = cosmos.readItem;
  t.mock.method(cosmos, 'readItem', async (container, id, pk) => (container === 'works'
    ? structuredClone(store.rows('works').find(r => r.id === id && r.projectId === pk) ?? null)
    : read(container, id, pk)));
  if (rows.length) assert.strictEqual((await writeTrackRecord('work', 'POST', PROJECT, fixture('new_work'))).status, 'applied');
  store.writes.length = 0;
  return store;
}

/** Runs `racer` before each of the first `losses` calls of `method` on `container`, so that call loses its etag. */
function raceOn(t, method, container, losses, racer) {
  const inner = cosmos[method];
  let left = losses;
  t.mock.method(cosmos, method, async (name, ...rest) => {
    if (name === container && left-- > 0) await racer(inner);
    return inner(name, ...rest);
  });
}

test('track record writer', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a phase PUT that moves no derived value writes the work document and not the row', async (t) => {
    const store = await seeded(t);
    const { events: _events, ...phase } = fixture('new_work').work.phases[0];

    const result = await writeTrackRecord('phase', 'PUT', PROJECT, { pushedAt: LATER, workTypeId: 6, phase: { ...phase, work_id: 2001 } });

    assert.strictEqual(result.status, 'applied');
    assert.deepStrictEqual([writesTo(store, 'works').length, writesTo(store, 'projects').length], [1, 0]);
  });

  await t.test('an event that dates the Act transition patches only derived paths on the row', async (t) => {
    const store = await seeded(t);

    await writeTrackRecord('event', 'POST', PROJECT, transitionEvent('2023-05-01T07:00:00+00:00'));

    const patches = writesTo(store, 'projects');
    assert.strictEqual(patches.length, 1);
    assert.ok(patches[0].operations.every(op => DERIVED_PATHS.includes(op.path)));
    assert.strictEqual(storedRow(store).legislationTransitions[0].date, '2023-05-01T07:00:00.000Z');
  });

  await t.test('a lost row race re-reads the row and the works, then patches', async (t) => {
    const store = await seeded(t);
    raceOn(t, 'patch', 'projects', 1, async () => {
      await cosmos.upsert('projects', { ...storedRow(store), name: 'Renamed' });
      const work = storedWork(store);
      const phases = work.phases.map(p => ({ ...p,
        milestones: p.milestones.map(m => (m.trackEventId === 4100 ? { ...m, actualDate: '2023-06-01T07:00:00.000Z' } : m)) }));
      await cosmos.upsert('works', { ...work, phases });
    });

    const result = await writeTrackRecord('event', 'POST', PROJECT, transitionEvent('2023-05-01T07:00:00+00:00'));

    assert.strictEqual(result.status, 'applied');
    assert.deepStrictEqual([storedRow(store).name, storedRow(store).legislationTransitions[0].date],
      ['Renamed', '2023-06-01T07:00:00.000Z']);
  });

  await t.test('three lost row races answer derived-conflict and log the record', async (t) => {
    const store = await seeded(t);
    raceOn(t, 'patch', 'projects', 3, () => cosmos.upsert('projects', { ...storedRow(store) }));
    const errors = t.mock.method(logger, 'error', () => {});

    const result = await writeTrackRecord('event', 'POST', PROJECT, transitionEvent('2023-05-01T07:00:00+00:00'));

    assert.strictEqual(result.status, 'derived-conflict');
    assert.strictEqual(errors.mock.calls[0].arguments[0], '[track-push] derived patch lost id=1001/work:2001');
  });

  await t.test('a stale etag on the work document is retried from a fresh read', async (t) => {
    const store = await seeded(t);
    raceOn(t, 'upsert', 'works', 1, (inner) => inner('works', { ...storedWork(store), simpleTitle: 'Racer' }));

    const result = await writeTrackRecord('event', 'POST', PROJECT, transitionEvent('2023-05-01T07:00:00+00:00'));

    const work = storedWork(store);
    assert.strictEqual(result.status, 'applied');
    assert.deepStrictEqual([work.simpleTitle, work.phases[0].milestones.some(m => m.trackEventId === 4100)], ['Racer', true]);
  });

  await t.test('a phase under a tombstoned work is parent-not-found and writes nothing', async (t) => {
    const store = await seeded(t);
    await writeTrackRecord('work', 'DELETE', PROJECT, { pushedAt: LATER, workTypeId: 6, id: 2001 });
    store.writes.length = 0;

    const result = await writeTrackRecord('phase', 'PUT', PROJECT, { ...fixture('phase'), pushedAt: LATER + 1 });

    assert.strictEqual(result.status, 'parent-not-found');
    assert.strictEqual(store.writes.length, 0);
  });

  await t.test('a phase DELETE finds the work that holds the phase', async (t) => {
    const store = await seeded(t);

    const result = await writeTrackRecord('phase', 'DELETE', PROJECT, { pushedAt: LATER, workTypeId: 6, id: 3001 });

    assert.strictEqual(result.status, 'applied');
    assert.deepStrictEqual(storedWork(store).phases.map(p => p.trackPhaseId), []);
  });

  await t.test('no project row answers project-not-found', async (t) => {
    await seeded(t, { rows: [] });

    const result = await writeTrackRecord('phase', 'PUT', PROJECT, fixture('phase'));

    assert.strictEqual(result.status, 'project-not-found');
  });

  await t.test('with WORKS_WRITE off it answers not-backfilled and calls no container', async (t) => {
    const flag = config.worksWrite;
    t.after(() => { config.worksWrite = flag; });
    config.worksWrite = false;
    const reads = t.mock.method(cosmos, 'readItem', async () => null);
    const queries = t.mock.method(cosmos, 'query', async () => ({ items: [] }));

    const result = await writeTrackRecord('phase', 'PUT', PROJECT, fixture('phase'));

    assert.strictEqual(result.status, 'not-backfilled');
    assert.deepStrictEqual([reads.mock.callCount(), queries.mock.callCount()], [0, 0]);
  });
});
