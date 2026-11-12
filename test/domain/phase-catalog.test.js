'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const listsRepository = require('../../src/repositories/lists');
const catalogs = require('../../src/domain/phase-catalog');
const { deriveAssessments } = require('../../src/merge/assessments');
const { resolveCatalog, run } = require('../../src/scripts/build-phase-catalog');
const { logger } = require('../../src/utils/logger');
const MAP = require('../../src/data/phase-catalog-map.json');

const ASSESSMENT = 6;
const PRE_EA_EAC = { id: 901, name: 'Pre-EA (EAC Assessment)', work_type_id: ASSESSMENT,
  ea_act: { name: 'EA Act (2018)' }, sort_order: 0 };

/** One `List` row per Eagle name in the map, as the backfill stores them. 1996 files under 2002. */
const LIST_ROWS = [2002, 2018].flatMap(year => MAP.acts[year].filter(entry => entry.eagle !== false)
  .map((entry, index) => ({ id: `list-${year}-${index}`, kind: 'List', type: 'projectPhase',
    legislation: year, name: entry.name, listOrder: index + 1 })));

/** One Track phase code per Track name in the map, plus one the map does not name. */
const TRACK_CODES = [...MAP.acts[2018].flatMap(entry => (entry.track || {})[ASSESSMENT] || [])
  .map((name, index) => ({ id: 100 + index, name, work_type_id: ASSESSMENT,
    ea_act: { name: 'EA Act (2018)' }, sort_order: index + 1 })), PRE_EA_EAC];

const resolved = resolveCatalog(MAP, { listRows: LIST_ROWS, trackCodes: TRACK_CODES });
const CATALOG = Object.fromEntries(resolved.items.map(item => [item.legislationYear, item.entries]));
const listIdOf = (year, name) => LIST_ROWS.find(row => row.legislation === year && row.name === name).id;
const trackIdOf = (name) => TRACK_CODES.find(code => code.name === name).id;

/** Today's stage for each name, read off `deriveAssessments` as Track phases of a one-Act row. */
function stagesToday(year, names) {
  const [assessment] = deriveAssessments({ read: ['public'], isPublished: true, legislationYearList: [year],
    phases: names.map(name => ({ name })) }).assessments;
  return new Map(assessment.phases.map(phase => [phase.name, phase.stage]));
}

function assertParity(year, names) {
  const today = stagesToday(year, names);
  assert.deepStrictEqual(
    names.map(name => [name, catalogs.stageOf(CATALOG, year, { name })]),
    names.map(name => [name, today.get(name)]));
}

test('the catalog gives every stage row and row alias the stage today\'s name rules give', async (t) => {
  await t.test('1996, which reads the 2002 rows', () => assertParity(1996,
    ['Pre-Application', 'Application Review', 'Referral', 'Post Decision', 'Pre-EA', 'Evaluation']));
  await t.test('2002', () => assertParity(2002,
    ['Pre-EA', 'Pre-Application', 'Evaluation', 'Application Review', 'Referral', 'Post Decision']));
  await t.test('2018', () => assertParity(2018, ['Early Engagement', 'Readiness Decision', 'Process Planning',
    'Application Development and Review', 'Effects Assessment and Recommendation', 'Referral and Decision',
    'Post Decision', 'EAC Application Review', 'Effects Assessment & Recommendation', 'Effects Assessment',
    'EAC Decision', 'Referral']));
});

test('one 2002 List id sits on a different stage under 1996 than under 2002', () => {
  const preEa = listIdOf(2002, 'Pre-EA');
  assert.strictEqual(catalogs.stageOf(CATALOG, 1996, { listId: preEa }), 'Pre-Application');
  assert.strictEqual(catalogs.stageOf(CATALOG, 2002, { listId: preEa }), 'Pre-EA');
});

test('a Track code the map does not name becomes a Track-only entry under Track\'s name', () => {
  const entry = catalogs.entryForTrackCode(CATALOG, 2018, PRE_EA_EAC.id);
  assert.strictEqual(entry.catalogId, 'track-901');
  assert.strictEqual(entry.eagleListId, null);
  assert.strictEqual(entry.name, 'Pre-EA (EAC Assessment)');
  assert.strictEqual(entry.stage, null);
});

test('several Track codes resolve to one Eagle-named entry', () => {
  const codes = ['EAC Application Development (Proponent Time)', 'EAC Application Review',
    'Revised EAC Application Development (Proponent Time)'].map(trackIdOf);
  assert.deepStrictEqual(codes.map(id => catalogs.entryForTrackCode(CATALOG, 2018, id).eagleListId),
    codes.map(() => listIdOf(2018, 'Application Development and Review')));
});

test('a mixed phaseHistory normalises to the same ids, and a ref finds the entry a bare id does', () => {
  const id = listIdOf(2002, 'Evaluation');
  assert.deepStrictEqual(catalogs.phaseHistoryIds([id, { _id: id, name: 'Evaluation' }, null]), [id, id]);
  assert.strictEqual(catalogs.entryForEagleId(CATALOG, 2002, { _id: id, name: 'Evaluation' }),
    catalogs.entryForEagleId(CATALOG, 2002, id));
});

test('with no catalog every lookup answers null', () => {
  assert.strictEqual(catalogs.stageOf({}, 2018, { name: 'Post Decision' }), null);
  assert.strictEqual(catalogs.entryForName(null, 2018, 'Referral'), null);
  assert.strictEqual(catalogs.entryForTrackCode(undefined, 2018, 100), null);
});

test('the resolve step builds one stored item per Act in the stored shape', () => {
  assert.deepStrictEqual(resolved.items.map(item => [item.id, item.kind]), [
    ['phase-catalog-1996', 'PhaseCatalog'], ['phase-catalog-2002', 'PhaseCatalog'],
    ['phase-catalog-2018', 'PhaseCatalog'], ['phase-catalog-2025', 'PhaseCatalog']]);
  assert.deepStrictEqual(catalogs.entryForName(CATALOG, 2018, 'Referral'), {
    catalogId: listIdOf(2018, 'Referral'), group: 'assessment', eagleListId: listIdOf(2018, 'Referral'),
    name: 'Referral', stage: 'Referral and Decision', order: 7, trackPhaseCodeIds: [trackIdOf('EAC Decision')],
    workTypeIds: [ASSESSMENT], aliases: ['Referral and Decision', 'EAC Decision']
  });
  assert.strictEqual(catalogs.entryForName(CATALOG, 2002, 'Construction').group, 'postDecision');
  assert.deepStrictEqual(resolved.missing, []);
});

test('a map name this environment lacks is reported, not stored', () => {
  const { items, missing } = resolveCatalog(MAP,
    { listRows: LIST_ROWS.filter(row => row.name !== 'Withdrawal'), trackCodes: TRACK_CODES });
  assert.deepStrictEqual(missing, ['1996 "Withdrawal": Eagle List row', '2002 "Withdrawal": Eagle List row']);
  assert.strictEqual(items[1].entries.some(entry => entry.name === 'Withdrawal'), false);
});

function fakeLists(stored = {}) {
  const writes = [];
  return {
    writes,
    listEveryOfKind: async (kind) => (kind === 'List' ? LIST_ROWS : []),
    readCatalog: async (year) => stored[year] || null,
    upsert: async (item) => { writes.push(item.id); }
  };
}

test('--dry-run writes nothing; the same run without it writes each Act', async (t) => {
  t.mock.method(logger, 'info', () => {});
  const dry = fakeLists();
  await run({ dryRun: true, deps: { lists: dry, trackCodes: async () => TRACK_CODES } });
  assert.deepStrictEqual(dry.writes, []);

  const live = fakeLists({ 2025: { entries: [] } });
  await run({ deps: { lists: live, trackCodes: async () => TRACK_CODES } });
  assert.deepStrictEqual(live.writes, ['phase-catalog-1996', 'phase-catalog-2002', 'phase-catalog-2018']);
});

test('load reads each Act\'s item once and leaves an Act with none out', async (t) => {
  const reads = [];
  t.mock.method(cosmos, 'readItem', async (container, id, partitionKey) => {
    reads.push(id);
    return container === 'lists' && id === 'phase-catalog-2018' && partitionKey === 'PhaseCatalog'
      ? { id, entries: CATALOG[2018] } : null;
  });
  const first = await catalogs.load(listsRepository);
  await catalogs.load(listsRepository);
  assert.strictEqual(reads.length, 4);
  assert.strictEqual(catalogs.stageOf(first, 2018, { name: 'EAC Decision' }), 'Referral and Decision');
  assert.strictEqual(catalogs.entryForName(first, 2002, 'Pre-EA'), null);
});
