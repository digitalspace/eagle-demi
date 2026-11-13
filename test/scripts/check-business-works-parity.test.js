'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { run } = require('../../src/scripts/check-business-works-parity');
const { mapBusinessWorks } = require('../../src/domain/business-works-map');
const { hiddenByOverride, overrideBoundaryOf } = require('../../src/domain/work-model');
const MAP = require('../../src/data/works-catalog-map.json');
const PHASE_MAP = require('../../src/data/phase-catalog-map.json');

const phaseId = (year, name) => `${year}:${name}`;
const CATALOG = {
  ...MAP, appliedTo: MAP.appliedTo.map(entry => ({ ...entry, catalogIds: { 1996: phaseId(1996, entry.phase), 2002: phaseId(2002, entry.phase) } }))
};
const PHASES = Object.fromEntries([1996, 2002].map(year =>
  [year, PHASE_MAP.acts[year].map(entry => ({ ...entry, catalogId: phaseId(year, entry.name) }))]));

const PROJECT = 'project-alpha';
const AT = '2026-11-13T00:00:00.000Z';
const CROSSWALK = new Map([[101, PROJECT]]);
const TEST_ENDPOINT = 'https://demi-cosmos-test.documents.azure.com:443/';
const ARGS = ['extract', 'expect-extract-sha256', 'crosswalk', 'expect-manual-sha256', 'devbox-key'].flatMap(name => [`--${name}`, 'x']);

const ref = (sheet, slot) => ({ file: 'made-up.xlsx', sheet, row: 5, ...(slot && { slot }) });
const register = () => ({
  ref: ref('Projects'), id: 101, name: 'Sample Mine', intakeType: 's.6', intakeDate: '2005-01-01',
  determinationType: 's.10(1)(c)', determinationDate: '2005-03-01', decision: 'EA Certificate Granted', decisionDate: '2008-05-01'
});
const amendment = (slot, startDate, endDate) => ({ ref: ref('Amendments', slot), id: 101, name: 'Sample Mine', startDate, endDate });
const extractOf = (...amendments) => ({ records: { projects: [register()], amendments } });
const trackWork = (n, fields) => ({
  id: `track-${n}`, projectId: PROJECT, source: 'track', workTypeId: 7, workState: 'IN_PROGRESS', startDate: null, decisionDate: null, ...fields
});
const settledAmendment = trackWork(500, { workState: 'COMPLETED', startDate: '2010-01-05', decisionDate: '2010-03-02' });
const decided2018 = trackWork(900, { workTypeId: 6, workState: 'COMPLETED', startDate: '2020-03-01', decisionDate: '2023-10-10' });

/** What a load of `extract` stores, with W8a's sourceKey to sheetWorkId swap on each marker. */
function loaded(extract, trackWorks = []) {
  const result = mapBusinessWorks(extract, {
    catalog: CATALOG, phaseCatalog: PHASES, crosswalk: CROSSWALK, batchId: 'batch-1', batchAt: AT,
    trackWorks: new Map([[PROJECT, trackWorks]])
  });
  const idOfKey = new Map(result.works.map(work => [work.sourceKey, work.id]));
  const markers = new Map(result.markers.map(marker => [marker.projectId, {
    ...marker,
    hidden: marker.hidden.map(pair => ({ trackWorkId: pair.trackWorkId, sheetWorkId: idOfKey.get(pair.sourceKey) })),
    untilTrack: marker.untilTrack.map(key => idOfKey.get(key))
  }]));
  return { works: result.works, markers };
}

const stateOf = ({ works, markers }, { track = [], rows = new Map([[PROJECT, { id: PROJECT }]]) } = {}) => ({
  rows, works: new Map([[PROJECT, [...works, ...track]]]), markers, commentPeriods: new Map(), catalog: CATALOG, phaseCatalog: PHASES
});

async function check(extract, state, { endpoint = TEST_ENDPOINT } = {}) {
  const lines = [];
  const code = await run(ARGS, {
    endpoint, open: () => ({ extract, crosswalk: CROSSWALK }), state: async () => state, write: line => lines.push(line), now: new Date(AT)
  });
  const count = (name) => Number(lines.find(line => line.startsWith(`${name}=`)).slice(name.length + 1));
  return { code, lines, count, listed: (name) => lines.filter(line => line.startsWith(`${name} `)) };
}

test('check-business-works-parity', async (t) => {
  const extract = extractOf(amendment('1', '2010-01-01', '2010-03-01'));

  await t.test('exits 0 with mismatch=0 when the stored works match the extract', async () => {
    const result = await check(extract, stateOf(loaded(extract)));
    assert.strictEqual(result.count('mismatch'), 0);
    assert.strictEqual(result.code, 0);
  });

  await t.test('exits 1 and lists the path when a stored date changed', async () => {
    const state = loaded(extract);
    const changed = state.works.map(work => (work.workTypeCode === 'amendment' ? { ...work, decisionDate: '2010-04-01' } : work));
    const result = await check(extract, stateOf({ ...state, works: changed }));
    assert.strictEqual(result.code, 1);
    assert.match(result.listed('mismatch')[0], /reason=dateChanged .*paths=\.decisionDate$/);
  });

  await t.test('exits 1 when two projects claim one (system, value) external id', async () => {
    const rows = new Map([[PROJECT, { id: PROJECT, externalIds: [{ system: 'track', value: '7' }] }],
      ['project-beta', { id: 'project-beta', externalIds: [{ system: 'track', value: '7' }] }]]);
    const result = await check(extract, stateOf(loaded(extract), { rows }));
    assert.strictEqual(result.count('duplicateExternalId'), 1);
    assert.strictEqual(result.code, 1);
  });

  await t.test('exits 1 when two stored works share a sourceKey', async () => {
    const state = loaded(extract);
    const twin = { ...state.works.find(work => work.workTypeCode === 'amendment'), id: 'sheet-twin' };
    const result = await check(extract, stateOf({ ...state, works: [...state.works, twin] }));
    assert.strictEqual(result.count('duplicateSourceKey'), 1);
    assert.strictEqual(result.code, 1);
  });

  await t.test('a reverted marker adds nothing to hiddenDrift and counts one overrideHeldOff', async () => {
    const state = loaded(extract);
    state.markers.get(PROJECT).active = false;
    const result = await check(extract, stateOf(state, { track: [settledAmendment] }));
    assert.deepStrictEqual([result.count('hiddenDrift'), result.count('overrideHeldOff')], [0, 1]);
  });

  await t.test('a covered Track work pushed after the load that matches a loaded sheet work is listed in hiddenDrift and stays shown', async () => {
    const state = loaded(extract);
    const result = await check(extract, stateOf(state, { track: [settledAmendment] }));
    assert.match(result.listed('hiddenDrift')[0], /reason=matchNotHidden trackWorkId=track-500 /);
    const sheetIds = state.works.map(work => work.id);
    assert.strictEqual(hiddenByOverride(settledAmendment, state.markers.get(PROJECT), overrideBoundaryOf([settledAmendment]), sheetIds), false);
  });

  await t.test('a trackAlive skip whose Track work was deleted is listed in hiddenDrift', async () => {
    const alive = trackWork(501, { startDate: '2010-01-05' });
    const state = loaded(extract, [alive]);
    const result = await check(extract, stateOf(state));
    assert.deepStrictEqual(result.listed('hiddenDrift'), [`hiddenDrift project=${PROJECT} reason=trackAliveGone trackWorkId=track-501 sourceKey=101:amendment:1`]);
  });

  await t.test('a sheet amendment closed 2023-11-01, loaded with boundaryAtLoad 2025-01-01, is listed sheetHiddenByMovedBoundary once a Track Assessment decided 2023-10-10 moves B', async () => {
    const late = extractOf(amendment('1', '2023-06-01', '2023-11-01'));
    const state = loaded(late);
    assert.strictEqual(state.markers.get(PROJECT).boundaryAtLoad, '2025-01-01');
    const result = await check(late, stateOf(state, { track: [decided2018] }));
    assert.match(result.listed('sheetHiddenByMovedBoundary')[0], /sourceKey=101:amendment:1 boundary=2023-10-10$/);
    assert.strictEqual(result.count('hiddenDrift'), 0);
  });

  await t.test('refuses a COSMOS_ENDPOINT outside the test account', async () => {
    await assert.rejects(check(extract, stateOf(loaded(extract)), { endpoint: 'https://demi-cosmos-prod.documents.azure.com:443/' }),
      { message: /must name demi-cosmos-test/ });
  });
});
