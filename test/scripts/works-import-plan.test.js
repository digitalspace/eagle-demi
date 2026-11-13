'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPlan } = require('../../src/scripts/works-import-plan');
const { ownerOf } = require('../../src/repositories/works');
const { CATALOG, PHASES, PROJECT, NUMBER, register, amendment, trackWork } = require('./works-import-fakes');

const KEY = `${NUMBER}:amendment:1`;
const extractOf = (records, flags = {}) => ({ staffIncluded: false, numbersReal: false, ...flags, records: { projects: [register], ...records } });

function plan(records, { stored = [], row = { id: PROJECT }, track = [], flags } = {}) {
  return buildPlan(extractOf(records, flags), {
    catalog: CATALOG, phaseCatalog: PHASES, crosswalk: new Map([[NUMBER, PROJECT]]), batchId: 'batch-1', batchAt: '2026-11-13T18:00:00Z',
    trackWorks: new Map([[PROJECT, track]]), stored: new Map([[PROJECT, [...track, ...stored]]]), storedMarkers: new Map(),
    rows: new Map([[PROJECT, row]]), trackPublic: new Map(), ownerOf
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
    { row: { id: PROJECT, staffAssignments: [open] }, flags: { staffIncluded: true } });
  const [append] = result.entries.filter(entry => entry.action === 'appendHistory');
  assert.deepEqual(append.close, { id: 'held-1', effectiveTo: '2026-11-13' });
});

test('never changes or removes an externalIds or history entry it did not write', () => {
  const staff = { id: 'held-2', role: 'epd', name: 'staff-value-1', effectiveFrom: null, effectiveTo: null, source: 'demi', sheetKey: 'register:epd' };
  const result = plan({ projects: [{ ...register, epd: 'staff-value-3' }] },
    { row: { id: PROJECT, staffAssignments: [staff] }, flags: { staffIncluded: true } });
  assert.deepEqual(result.entries.filter(entry => entry.action === 'appendHistory').map(entry => entry.close), [null]);
});

test('dry run lists a Track amendment started 2024-11-01 and decided 2025-03-01 as trackShownStartedBefore, and its sheet counterpart as afterBoundary', () => {
  const track = [trackWork(50, { startDate: '2024-11-01', decisionDate: '2025-03-01' })];
  const result = plan({ amendments: [amendment(1, '2024-11-01', '2025-03-01')] }, { track });
  assert.deepEqual(result.lists.trackShownStartedBefore.map(item => item.workId), ['track-50']);
  assert.deepEqual(result.lists.afterBoundary.map(item => item.sourceKey), [KEY]);
});
