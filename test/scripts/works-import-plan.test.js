'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPlan } = require('../../src/scripts/works-import-plan');
const { ownerOf } = require('../../src/repositories/works');
const { CATALOG, PHASES, PROJECT, NUMBER, ref, register, amendment, trackWork } = require('../helpers/works-import-fakes');

const KEY = `${NUMBER}:amendment:1`;
const extractOf = (records, flags = {}) => ({ staffIncluded: false, numbersReal: false, ...flags, records: { projects: [register], ...records } });

function plan(records, { stored = [], row = { id: PROJECT }, track = [], markers = new Map(), flags, options } = {}) {
  return buildPlan(extractOf(records, flags), {
    ...options,
    catalog: CATALOG, phaseCatalog: PHASES, crosswalk: new Map([[NUMBER, PROJECT], [477, PROJECT]]), batchId: 'batch-1', batchAt: '2026-11-13T18:00:00Z',
    trackWorks: new Map([[PROJECT, track]]), stored: new Map([[PROJECT, [...track, ...stored]]]), storedMarkers: markers,
    rows: new Map(row ? [[PROJECT, row]] : []), trackPublic: new Map(), ownerOf
  });
}

const amended = { amendments: [amendment(1, '2010-06-01', '2010-11-07')] };
const sheetDoc = (id, owner) => ({ id, projectId: PROJECT, source: owner, owner, sourceKey: KEY, _etag: '"s"' });

test('refuses a track-owned id', () => {
  assert.throws(() => plan(amended, { stored: [sheetDoc('track-9', 'sheet')] }), /not sheet-owned/);
});

test('skips a document whose owner is not sheet', () => {
  const result = plan(amended, { stored: [sheetDoc('demi-1', 'demi')] });
  assert.equal(result.entries.filter(entry => entry.sourceKey === KEY).length, 0);
  assert.deepEqual(result.report.filter(entry => entry.reason === 'ownerNotSheet').map(entry => entry.workId), ['demi-1']);
});

test('an update keeps the stored id of its sourceKey and records the stored body hash', () => {
  const [entry] = plan(amended, { stored: [sheetDoc('sheet-kept', 'sheet')] }).entries.filter(one => one.sourceKey === KEY);
  assert.equal(entry.action, 'update');
  assert.equal(entry.doc.id, 'sheet-kept');
  assert.match(entry.currentSha256, /^[0-9a-f]{64}$/);
});

test('a stored work carries summaryOf', () => {
  const [entry] = plan(amended).entries.filter(one => one.sourceKey === KEY);
  assert.equal(entry.doc.summary.elapsedDays, 159);
});

test('test load with no sign-off refs writes no history entry, note or real number', () => {
  const result = plan({ projects: [{ ...register, epd: 'staff-value-1', notes: 'staff-value-2' }] });
  assert.deepEqual(result.entries.filter(entry => ['addExternalId', 'appendHistory'].includes(entry.action)), []);
});

test('a changed current EPD closes the open sheet entry and appends one', () => {
  const open = { id: 'held-1', role: 'epd', name: 'staff-value-1', effectiveFrom: null, effectiveTo: null, source: 'sheet', sheetKey: 'register:epd' };
  const result = plan({ projects: [{ ...register, epd: 'staff-value-3' }] },
    { row: { id: PROJECT, staffAssignments: [open] }, flags: { staffIncluded: true, signoffRefs: { keepStaff: 'so-staff' } } });
  const [append] = result.entries.filter(entry => entry.action === 'appendHistory');
  assert.deepEqual(append.close, { id: 'held-1', effectiveTo: '2026-11-13' });
});

test('never changes or removes an externalIds or history entry it did not write', () => {
  const staff = { id: 'held-2', role: 'epd', name: 'staff-value-1', effectiveFrom: null, effectiveTo: null, source: 'demi', sheetKey: 'register:epd' };
  const result = plan({ projects: [{ ...register, epd: 'staff-value-3' }] },
    { row: { id: PROJECT, staffAssignments: [staff] }, flags: { staffIncluded: true, signoffRefs: { keepStaff: 'so-staff' } } });
  assert.deepEqual(result.entries.filter(entry => entry.action === 'appendHistory').map(entry => entry.close), [null]);
});

test('dry run lists a Track amendment started 2024-11-01 and decided 2025-03-01 as trackShownStartedBefore, and its sheet counterpart as afterBoundary', () => {
  const track = [trackWork(50, { startDate: '2024-11-01', decisionDate: '2025-03-01' })];
  const result = plan({ amendments: [amendment(1, '2024-11-01', '2025-03-01')] }, { track });
  assert.deepEqual(result.lists.trackShownStartedBefore.map(item => item.workId), ['track-50']);
  assert.deepEqual(result.lists.afterBoundary.map(item => item.sourceKey), [KEY]);
});

test('a stored sheet work the spreadsheet no longer holds is tombstoned', () => {
  const gone = { ...sheetDoc('sheet-gone', 'sheet'), sourceKey: `${NUMBER}:amendment:9` };
  const [entry] = plan(amended, { stored: [gone] }).entries.filter(one => one.action === 'tombstone');
  assert.deepEqual([entry.current.id, entry.sourceKey], ['sheet-gone', `${NUMBER}:amendment:9`]);
});

test('oversize work becomes a report entry', () => {
  const suspensions = Array.from({ length: 2001 }, (_, i) => ({
    ref: ref('Suspensions', i + 1), id: NUMBER, type: 'Suspension s.24(2)', appliedTo: 'Review', startDate: '2006-02-01', endDate: '2006-03-01'
  }));
  const result = plan({ projects: [{ ...register, start180: '2006-01-01' }], suspensions });
  const [oversize] = result.report.filter(entry => (entry.errors || []).some(error => error.rule === 'oversize'));
  assert.equal(result.entries.filter(entry => entry.sourceKey === oversize.sourceKey).length, 0);
});

test('dry run reports trackTransitionMissing for 477 with 2025-05-21', () => {
  const records = { projects: [{ ...register, id: 477, decision: null, decisionDate: null }], transitions: [{ ref: ref('EA Process Data'), id: 477, date: '2025-05-21' }] };
  const result = plan(records, { options: { transitionIdsAreRegisterIds: true } });
  assert.deepEqual(result.lists.trackTransitionMissing.map(item => [item.projectId, item.fallbackDate]), [[PROJECT, '2025-05-21']]);
});

test('refuses staff columns without a keepStaff sign-off ref', () => {
  assert.throws(() => plan(amended, { flags: { staffIncluded: true, signoffRefs: { keepStaff: null } } }), /keepStaff/);
});

test('refuses real numbers without a keepNumbers sign-off ref', () => {
  assert.throws(() => plan(amended, { flags: { numbersReal: true, signoffRefs: { keepNumbers: null } } }), /keepNumbers/);
});

test('a crosswalk target with no project row is reported and gets no writes', () => {
  const result = plan(amended, { row: null });
  assert.deepEqual(result.entries, []);
  assert.deepEqual(result.report.filter(entry => entry.reason === 'projectMissing').map(entry => entry.projectId), [PROJECT]);
});

test('an oversize work that is already stored is kept, not tombstoned', () => {
  const suspensions = Array.from({ length: 2001 }, (_, i) => ({
    ref: ref('Suspensions', i + 1), id: NUMBER, type: 'Suspension s.24(2)', appliedTo: 'Review', startDate: '2006-02-01', endDate: '2006-03-01'
  }));
  const records = { projects: [{ ...register, start180: '2006-01-01' }], suspensions };
  const [oversize] = plan(records).report.filter(entry => (entry.errors || []).some(error => error.rule === 'oversize'));
  const result = plan(records, { stored: [{ ...sheetDoc('sheet-big', 'sheet'), sourceKey: oversize.sourceKey }] });
  assert.equal(result.entries.filter(entry => entry.action === 'tombstone').length, 0);
});

test('an active stored marker the load does not rebuild is turned off', () => {
  const stored = { id: 'sheet-override', projectId: PROJECT, kind: 'override', source: 'sheet', owner: 'sheet', active: true, hidden: [], untilTrack: [] };
  const noCertificate = { projects: [{ ...register, decision: null, decisionDate: null }] };
  const [entry] = plan(noCertificate, { markers: new Map([[PROJECT, stored]]) }).entries.filter(one => one.action === 'marker');
  assert.deepEqual([entry.doc.active, entry.doc.batchId], [false, 'batch-1']);
});

test('the live document of a sourceKey wins over its tombstone', () => {
  const stored = [{ ...sheetDoc('sheet-dead', 'sheet'), deleted: true }, sheetDoc('sheet-live', 'sheet')];
  const [entry] = plan(amended, { stored }).entries.filter(one => one.sourceKey === KEY);
  assert.equal(entry.doc.id, 'sheet-live');
});

test('a create\'s bodySha256 is the same across two dry runs', () => {
  const sha = () => plan(amended).entries.find(entry => entry.sourceKey === KEY).bodySha256;
  assert.equal(sha(), sha());
});

test('sheetShown leaves out a sheet amendment a held-off marker hides', () => {
  const heldOff = { id: 'sheet-override', projectId: PROJECT, kind: 'override', source: 'sheet', owner: 'sheet', active: false };
  const markers = new Map([[PROJECT, heldOff]]);
  const result = plan(amended, { markers, options: { markers } });
  const loaded = result.entries.filter(entry => entry.action === 'create').length;
  assert.equal(result.lists.sheetShown, loaded - 1);
});
