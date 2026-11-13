'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { parityOf } = require('../../src/domain/business-works-parity');
const { idOf } = require('../../src/domain/extensions');
const { overrideShown } = require('../../src/domain/works-derive');
const { PRIVATE_KEYS } = require('../../src/repositories/works');
const { eagleOnlyProjectId } = require('../../src/merge/project');
const {
  PROJECT, AT, CROSSWALK, register, amendment, extractOf, trackWork, settledAmendment, aliveAmendment, decided2018, loaded, stateOf, withChild
} = require('../helpers/business-works-fixtures');

const extract = extractOf(amendment('1', '2010-01-01', '2010-03-01'));
const open = extractOf(amendment('1', '2010-01-01', null));
const KEY = '101:amendment:1';

const parity = (input, state, crosswalk = CROSSWALK) => {
  const { counts, items } = parityOf({ extract: input, crosswalk, ...state, at: AT });
  return { counts, listed: (name) => items.filter(item => item.list === name) };
};
const reasons = (result) => result.listed('hiddenDrift').map(item => item.reason);
const withWorks = (state, edit) => ({ ...state, works: state.works.map(edit) });
const isAmendment = (work) => work.workTypeCode === 'amendment';

test('a matching load counts the projects and works compared and nothing else', () => {
  const { counts } = parity(extract, stateOf(loaded(extract)));
  const nonzero = Object.entries(counts).filter(([, n]) => n > 0).map(([name]) => name);
  assert.deepStrictEqual(nonzero, ['projects', 'works']);
});

test('a reverted marker adds nothing to hiddenDrift and counts one overrideHeldOff', () => {
  const state = loaded(extract);
  state.markers.get(PROJECT).active = false;
  const { counts } = parity(extract, stateOf(state, { track: [settledAmendment] }));
  assert.deepStrictEqual([counts.hiddenDrift, counts.overrideHeldOff], [0, 1]);
});

test('a covered Track work pushed after the load that matches a loaded sheet work is listed in hiddenDrift and stays shown', () => {
  const [item] = parity(extract, stateOf(loaded(extract), { track: [settledAmendment] })).listed('hiddenDrift');
  assert.deepStrictEqual([item.reason, item.trackWorkId, item.shown], ['matchNotHidden', 'track-500', true]);
});

test('a Track work the marker pairs with another shown sheet work is listed matchNotHidden and not shown', () => {
  const two = extractOf(amendment('1', '2010-01-01', '2010-03-01'), amendment('2', '2015-01-01', '2015-03-01'));
  const state = loaded(two, [settledAmendment]);
  const other = state.works.find(work => work.sourceKey === '101:amendment:2');
  state.markers.get(PROJECT).hidden = [{ trackWorkId: 'track-500', sheetWorkId: other.id }];
  const [item] = parity(two, stateOf(state, { track: [settledAmendment] })).listed('hiddenDrift').filter(one => one.reason === 'matchNotHidden');
  assert.deepStrictEqual([item.sourceKey, item.shown], [KEY, false]);
});

test('a trackAlive skip whose Track work was deleted is listed in hiddenDrift', () => {
  assert.deepStrictEqual(parity(extract, stateOf(loaded(extract, [aliveAmendment]))).listed('hiddenDrift'),
    [{ list: 'hiddenDrift', project: PROJECT, reason: 'trackAliveGone', trackWorkId: 'track-501', sourceKey: KEY }]);
});

test('a sheet amendment closed 2023-11-01, loaded with boundaryAtLoad 2025-01-01, is listed sheetHiddenByMovedBoundary once a Track Assessment decided 2023-10-10 moves B', () => {
  const late = extractOf(amendment('1', '2023-06-01', '2023-11-01'));
  const state = loaded(late);
  assert.strictEqual(state.markers.get(PROJECT).boundaryAtLoad, '2025-01-01');
  const result = parity(late, stateOf(state, { track: [decided2018] }));
  const [item] = result.listed('sheetHiddenByMovedBoundary');
  assert.deepStrictEqual([item.sourceKey, item.boundary, result.counts.hiddenDrift], [KEY, '2023-10-10', 0]);
});

const period = { id: 'cp-1', read: ['public'] };
const suspension = { type: 'Suspension', start: '2007-01-01', end: '2007-02-01' };
const linked = (key, links) => withChild(loaded(extract), key, { id: 'child', links });
const cpLinked = (periods) => stateOf(linked('milestones', { commentPeriodId: 'cp-1' }), { commentPeriods: new Map([[PROJECT, periods]]) });
// [count, expected, case, stored state]
const counterRows = [
  ['danglingEagleItemId', 1, 'an interruption links an Eagle item the row lacks', () => stateOf(linked('interruptions', { eagleItemId: 'gone' }))],
  ['danglingEagleItemId', 0, 'an interruption links an Eagle item the row holds', () => stateOf(linked('interruptions', { eagleItemId: idOf(suspension) }),
    { rows: new Map([[PROJECT, { id: PROJECT, reviewSuspensions: [suspension] }]]) })],
  ['commentPeriodMissing', 1, 'a milestone links a comment period that is gone', () => cpLinked([])],
  ['commentPeriodMissing', 1, 'a milestone links a deleted comment period', () => cpLinked([{ ...period, isDeleted: true }])],
  ['commentPeriodMissing', 0, 'a milestone links a live public comment period', () => cpLinked([period])],
  ['commentPeriodNotPublic', 1, 'a milestone links a staff-only comment period', () => cpLinked([{ ...period, read: ['staff'] }])],
  ['commentPeriodNotPublic', 0, 'a milestone links a public comment period', () => cpLinked([period])],
  ['undatedDates', 1, 'a stored work carries an undated date', () =>
    stateOf(withWorks(loaded(extract), (work, i) => (i === 0 ? { ...work, undated: { decisionDate: true } } : work)))],
  ['mismatch', 0, 'a stored date is the same day as a date-time', () =>
    stateOf(withWorks(loaded(extract), work => (isAmendment(work) ? { ...work, decisionDate: '2010-03-01T12:00:00Z' } : work)))],
  ['mismatch', 0, 'a stored work holds as null a date the sheet work lacks', () =>
    stateOf(withWorks(loaded(extract), work => (isAmendment(work) ? { ...work, anticipatedDecisionDate: null } : work)))],
  ['mismatch', 0, "an active marker's trackAlive work is unstored and its Track work was deleted", () => stateOf(loaded(extract, [aliveAmendment]))],
  ['markerMissing', 1, 'the extract makes a marker the store lacks', () => stateOf({ ...loaded(extract), markers: new Map() })],
  ['sheetOutsideCrosswalk', 1, 'a project outside the crosswalk holds sheet works', () =>
    stateOf(loaded(extract), { sheetProjectIds: [PROJECT, 'project-beta', 'project-beta'] })],
  ['duplicateExternalId', 1, 'two stored projects hold one id in different case', () => stateOf(loaded(extract), {
    rows: new Map([[PROJECT, { id: PROJECT, externalIds: [{ system: 'track', value: 'AbC' }] }],
      ['project-beta', { id: 'project-beta', externalIds: [{ system: 'track', value: 'abc' }] }]])
  })],
  ['duplicateExternalId', 0, 'a folded twin holds the same id as its target', () => {
    const twinId = eagleOnlyProjectId('5f0000000000000000000001');
    return stateOf(loaded(extract), {
      rows: new Map([[PROJECT, { id: PROJECT, externalIds: [{ system: 'track', value: '7' }] }],
        [twinId, { id: twinId, eagleId: '5f0000000000000000000001', foldedInto: PROJECT, externalIds: [{ system: 'track', value: '7' }] }]])
    });
  }]
];
for (const [name, expected, label, build] of counterRows) {
  test(`${name}=${expected} when ${label}`, () => {
    assert.strictEqual(parity(extract, build()).counts[name], expected);
  });
}

test('a stored open date that is not a date is a dateChanged mismatch', () => {
  const state = withWorks(loaded(open), work => (isAmendment(work) ? { ...work, decisionDate: 'not a date' } : work));
  assert.strictEqual(parity(open, stateOf(state)).listed('mismatch')[0].paths, '.decisionDate');
});

test('a changed milestone date inside a phase is one dateChanged mismatch named by phase and milestone id', () => {
  const state = withWorks(loaded(extract), work => (work.workTypeCode !== 'assessment' ? work : {
    ...work,
    phases: work.phases.map(phase => (phase.id !== 'pre-ea' ? phase : {
      ...phase, milestones: phase.milestones.map(one => (one.id === 'intake' ? { ...one, actualDate: '2005-01-02' } : one))
    }))
  }));
  const result = parity(extract, stateOf(state));
  assert.deepStrictEqual([result.counts.mismatch, result.listed('mismatch')[0].paths], [1, '.phases[pre-ea].milestones[intake].actualDate']);
});

test('the extract claiming an id a stored project holds is a duplicate only when its numbers are real', () => {
  const rows = new Map([[PROJECT, { id: PROJECT }], ['project-beta', { id: 'project-beta', externalIds: [{ system: 'eao-register', value: '101' }] }]]);
  const counts = [false, true].map(numbersReal => parity({ ...extract, numbersReal }, stateOf(loaded(extract), { rows })).counts.duplicateExternalId);
  assert.deepStrictEqual(counts, [0, 1]);
});

test('two extract amendments with one sourceKey are a sheet-side duplicateSourceKey', () => {
  const twice = extractOf(amendment('1', '2010-01-01', '2010-03-01'), amendment('1', '2011-01-01', '2011-03-01'));
  assert.deepStrictEqual(parity(twice, stateOf(loaded(twice))).listed('duplicateSourceKey').map(item => item.side), ['sheet']);
});

test('sheet rows outside the crosswalk or without a register row fail as notInCrosswalk and noRegisterRow', () => {
  const stray = { records: { projects: [register()], amendments: [amendment('1', '2010-01-01', '2010-03-01', 999), amendment('2', '2010-01-01', '2010-03-01', 103)] } };
  const { counts } = parity(stray, stateOf(loaded(extract)), new Map([[101, PROJECT], [103, 'project-gamma']]));
  assert.deepStrictEqual([counts.notInCrosswalk, counts.noRegisterRow], [1, 1]);
});

test('an empty crosswalk is refused', () => {
  assert.throws(() => parity(extract, stateOf(loaded(extract)), new Map()), { message: 'crosswalk holds no project' });
});

test('a marker with no valid boundaryAtLoad is refused', () => {
  const state = loaded(extract);
  state.markers.get(PROJECT).boundaryAtLoad = 'soon';
  assert.throws(() => parity(extract, stateOf(state)), { message: /no valid boundaryAtLoad/ });
});

test('an untilTrack work missing from the store is one notStored mismatch, marker active or reverted', () => {
  const results = [true, false].map((active) => {
    const state = loaded(open);
    state.markers.get(PROJECT).active = active;
    return parity(open, stateOf({ ...state, works: state.works.filter(work => !isAmendment(work)) }));
  });
  assert.deepStrictEqual(results.map(result => result.listed('mismatch').map(item => [item.reason, Boolean(item.sheetWorkId), item.sourceKey])),
    [[['notStored', true, undefined]], [['notStored', false, KEY]]]);
  // The fresh pairing still names the work untilTrack, once and by its sourceKey.
  assert.deepStrictEqual(results[0].listed('hiddenDrift').map(item => [item.reason, item.sourceKey]), [['untilTrackChanged', KEY]]);
});

test('a hidden pair whose Track work is no longer settled is listed once, not again as aliveNotSkipped', () => {
  const result = parity(extract, stateOf(loaded(extract, [settledAmendment]), { track: [{ ...settledAmendment, decisionDate: '2025-03-01' }] }));
  assert.deepStrictEqual(reasons(result), ['hiddenNotSettled']);
});

test('an untilTrack work two new Track works stand for counts once', () => {
  const track = [trackWork(502, { startDate: '2010-01-05' }), trackWork(503, { startDate: '2010-01-10' })];
  const result = parity(open, stateOf(loaded(open), { track }));
  assert.deepStrictEqual(result.listed('untilTrackHidden').map(item => [item.sourceKey, item.trackWorkId]), [[KEY, 'track-502']]);
});

test('on an equal gap, parity and the read name the same untilTrack work a Track work hides', () => {
  const twin = extractOf(amendment('1', '2010-01-01', null), amendment('2', '2010-01-01', null));
  const state = loaded(twin);
  // Ids in the reverse of sourceKey order, so a sourceKey tie-break and an id tie-break disagree.
  const idFor = { '101:amendment:1': 'sheet-00000000-0000-4000-8000-00000000000b', '101:amendment:2': 'sheet-00000000-0000-4000-8000-00000000000a' };
  const old = new Map(state.works.map(work => [work.id, work.sourceKey]));
  state.works = state.works.map(work => (idFor[work.sourceKey] ? { ...work, id: idFor[work.sourceKey] } : work));
  const marker = state.markers.get(PROJECT);
  marker.untilTrack = marker.untilTrack.map(id => idFor[old.get(id)]);
  const track = [trackWork(502, { startDate: '2010-01-01' })];
  const [item] = parity(twin, stateOf(state, { track })).listed('untilTrackHidden');
  const read = state.works.map(work => Object.fromEntries(Object.entries(work).filter(([key]) => !PRIVATE_KEYS.has(key))));
  assert.deepStrictEqual([item.sheetWorkId], [...overrideShown(read, track, marker).replaced]);
});

// [the fields its one hiddenDrift item carries, extract, stored state]
const driftRows = [
  [{ reason: 'hiddenTrackGone', trackWorkId: 'track-500' }, extract, () => stateOf(loaded(extract, [settledAmendment]))],
  [{ reason: 'aliveNotSkipped', trackWorkId: 'track-501' }, extract, () => stateOf(loaded(extract), { track: [aliveAmendment] })],
  [{ reason: 'untilTrackChanged', sourceKey: KEY }, open, () => {
    const state = loaded(open);
    state.markers.get(PROJECT).untilTrack = [];
    return stateOf(state);
  }]
];
for (const [fields, input, build] of driftRows) {
  test(`hiddenDrift lists ${fields.reason}`, () => {
    const items = parity(input, build()).listed('hiddenDrift');
    assert.deepStrictEqual(items.map(item => Object.fromEntries(Object.keys(fields).map(key => [key, item[key]]))), [fields]);
  });
}
