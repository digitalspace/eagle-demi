'use strict';

// The twin fold through the nightly's relink and through the one-off script. Repositories are in-memory fakes.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { foldTwins, exitCodeFor } = require('../../src/scripts/fold-twins');
const { syncProjects } = require('../../src/scripts/sync-track-run');
const { readForLevel } = require('../../src/helpers/access-sql');
const { STAFF_ROLE_FIELDS } = require('../../src/ownership/project');
const { logger } = require('../../src/utils/logger');
const {
  NOW, API_PROJECT, storedProject, eagleOnlyProject, fakeLinks, fakeProjects
} = require('../helpers/track-sync-fakes');

const TWIN_ID = `eagle-${API_PROJECT.epic_guid}`;
const PAIRS = ['--pairs', `207:${API_PROJECT.epic_guid}`];

/** One made-up entry in each staff list. */
const staffLists = () => ({
  externalIds: [{ id: 'x1', system: 'eao-register', value: '9001', source: 'demi', recordedAt: NOW }],
  staffAssignments: [{ id: 's1', role: 'lead', name: 'Sample Lead', effectiveFrom: null, effectiveTo: null }],
  capitalInvestments: [{ id: 'c1', amountCad: 1000, effectiveFrom: null, effectiveTo: null, workId: null }],
  staffNotes: [{ id: 'n1', text: 'Sample note', workId: null }]
});

const quiet = (t) => {
  for (const level of ['info', 'warn', 'error']) t.mock.method(logger, level, () => {});
};

const stored = (projects, id) => projects.items.find(row => String(row.id) === id);

/** A DEMI-owned twin, narrower than its Track row, holding the staff lists and DEMI-only fields. */
const ownedTwin = (overrides = {}) => eagleOnlyProject({
  read: readForLevel(2), isPublished: false, demiOwnedAt: NOW, syncOut: { eagle: {} },
  tags: ['tag-1'], pins: ['pin-1'], levelHeldAt: NOW, ...staffLists(), ...overrides
});

/** A dry run, then a live run handed the dry run's hash. */
async function foldLive(projects) {
  const dry = await foldTwins(PAIRS, { projects, now: NOW });
  return foldTwins([...PAIRS, '--live', '--expect-plan-sha256', dry.planSha256], { projects, now: NOW });
}

test('relink strips the four staff-only fields from the twin', async (t) => {
  quiet(t);
  const projects = fakeProjects([eagleOnlyProject(staffLists())]);

  await syncProjects([API_PROJECT], { live: true, deps: { projects, links: fakeLinks() }, now: NOW });

  const row = stored(projects, '207');
  const twin = stored(projects, TWIN_ID);
  assert.deepStrictEqual(STAFF_ROLE_FIELDS.map(field => row[field]), Object.values(staffLists()));
  assert.deepStrictEqual(STAFF_ROLE_FIELDS.filter(field => field in twin), []);
  assert.strictEqual(twin.foldedInto, '207');
});

test('fold carries tags, pins and levelHeldAt, keeps the stricter read, stamps foldedInto', async (t) => {
  quiet(t);
  // Wider than its Track row: an owned twin's carry would otherwise hand its own level over.
  const projects = fakeProjects([storedProject({ read: readForLevel(2), isPublished: false }),
    ownedTwin({ read: readForLevel(4), isPublished: true })]);

  const wrong = await foldTwins([...PAIRS, '--live', '--expect-plan-sha256', 'a'.repeat(64)], { projects, now: NOW });
  assert.deepStrictEqual([wrong.planChanged, projects.writes.length], [true, 0], 'a plan that moved writes nothing');

  const summary = await foldLive(projects);

  assert.deepStrictEqual([summary.written, exitCodeFor(summary)], [1, 0]);
  const row = stored(projects, '207');
  const twin = stored(projects, TWIN_ID);
  assert.deepStrictEqual([row.tags, row.pins, row.levelHeldAt], [['tag-1'], ['pin-1'], NOW]);
  assert.deepStrictEqual([row.read, row.isPublished], [readForLevel(2), false]);
  assert.deepStrictEqual(STAFF_ROLE_FIELDS.map(field => row[field]), Object.values(staffLists()));
  assert.strictEqual(twin.foldedInto, '207');
  assert.deepStrictEqual(['demiOwnedAt', 'syncOut', ...STAFF_ROLE_FIELDS].filter(field => field in twin), []);
});

test('fold refuses while the Track row lacks the eagleId', async (t) => {
  quiet(t);
  const projects = fakeProjects([storedProject({ eagleId: null }), ownedTwin()]);

  const summary = await foldLive(projects);

  assert.deepStrictEqual([summary.refused, summary.written, exitCodeFor(summary)], [1, 0, 1]);
  assert.deepStrictEqual(projects.writes, []);
});

test('fold refuses a field both rows hold with different values', async (t) => {
  quiet(t);
  const projects = fakeProjects([storedProject({ tags: ['track-tag'] }), ownedTwin()]);

  const summary = await foldLive(projects);

  assert.deepStrictEqual([summary.refused, projects.writes.length], [1, 0]);
});

test('second fold run plans nothing', async (t) => {
  quiet(t);
  const projects = fakeProjects([storedProject(), ownedTwin()]);
  await foldLive(projects);
  const writes = projects.writes.length;

  const again = await foldLive(projects);

  assert.deepStrictEqual([again.folds, again.refused, again.written], [0, 0, 0]);
  assert.strictEqual(projects.writes.length, writes);
});
