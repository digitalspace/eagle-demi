'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPlan } = require('../../src/scripts/works-import-plan');
const { ownerOf } = require('../../src/repositories/works');
const { mapperInputs } = require('../../src/domain/business-works-inputs');
const { listsOf } = require('../../src/scripts/works-import-lists');
const { CATALOG, PHASES, PROJECT, NUMBER, ref, register, amendment, trackWork } = require('../helpers/works-import-fakes');

const KEY = `${NUMBER}:amendment:1`;
const extractOf = (records, flags = {}) => ({ staffIncluded: false, numbersReal: false, ...flags, records: { projects: [register], ...records } });

function plan(records, { stored = [], row = { id: PROJECT }, track = [], markers = new Map(), flags, options } = {}) {
  const rows = new Map(row ? [[PROJECT, row]] : []);
  const works = new Map([[PROJECT, [...track, ...stored]]]);
  const crosswalk = new Map([[NUMBER, PROJECT], [477, PROJECT]]);
  const mapper = mapperInputs({
    crosswalk, catalog: CATALOG, phaseCatalog: PHASES, rows, works, markers, commentPeriods: new Map(), batchId: 'batch-1', batchAt: '2026-11-13T18:00:00Z'
  });
  mapper.base = { ...mapper.base, ...options };
  return buildPlan(extractOf(records, flags), { mapper, stored: works, storedMarkers: markers, rows, trackPublic: new Map(), ownerOf });
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
  assert.throws(() => plan({ projects: [{ ...register, epd: 'staff-value-1' }] }, { flags: { staffIncluded: true, signoffRefs: { keepStaff: ' ' } } }), /keepStaff/);
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
  assert.deepEqual([entry.doc.active, entry.doc.deactivatedBy, entry.doc.batchId], [false, 'load', 'batch-1']);
});

const storedMarker = fields => ({ id: 'sheet-override', projectId: PROJECT, kind: 'override', source: 'sheet', owner: 'sheet', active: false, ...fields });

test('a later load that rebuilds a marker it turned off turns it back on', () => {
  const result = plan(amended, { markers: new Map([[PROJECT, storedMarker({ deactivatedBy: 'load' })]]) });
  const [entry] = result.entries.filter(one => one.action === 'marker');
  assert.equal(entry.doc.active, true);
  assert.deepEqual(result.report.filter(one => one.reason === 'overrideHeldOff'), []);
});

test('a marker staff turned off stays off and is reported overrideHeldOff', () => {
  const result = plan(amended, { markers: new Map([[PROJECT, storedMarker({})]]) });
  const [entry] = result.entries.filter(one => one.action === 'marker');
  assert.equal(entry.doc.active, false);
  assert.deepEqual(result.report.filter(one => one.reason === 'overrideHeldOff').map(one => one.projectId), [PROJECT]);
});

test('the live document of a sourceKey wins over its tombstone', () => {
  const stored = [{ ...sheetDoc('sheet-dead', 'sheet'), deleted: true }, sheetDoc('sheet-live', 'sheet')];
  const [entry] = plan(amended, { stored }).entries.filter(one => one.sourceKey === KEY);
  assert.equal(entry.doc.id, 'sheet-live');
});

test('a tombstoned Track work hides no sheet work', () => {
  const track = [trackWork(50, { startDate: '2010-06-01', decisionDate: '2010-11-07', deleted: true })];
  const [entry] = plan(amended, { track }).entries.filter(one => one.action === 'marker');
  assert.deepEqual(entry.doc.hidden, []);
});

test('a tombstoned override marker does not hold the fresh marker off', () => {
  const tombstoned = { id: 'sheet-override', projectId: PROJECT, deleted: true, source: 'sheet', owner: 'sheet' };
  const [entry] = plan(amended, { markers: new Map([[PROJECT, tombstoned]]) }).entries.filter(one => one.action === 'marker');
  assert.equal(entry.doc.active, true);
});

test('a create\'s bodySha256 is the same across two dry runs', () => {
  const sha = () => plan(amended).entries.find(entry => entry.sourceKey === KEY).bodySha256;
  assert.equal(sha(), sha());
});

test('sheetShown leaves out a sheet amendment a held-off marker hides', () => {
  const heldOff = { id: 'sheet-override', projectId: PROJECT, kind: 'override', source: 'sheet', owner: 'sheet', active: false };
  const markers = new Map([[PROJECT, heldOff]]);
  const result = plan(amended, { markers });
  const loaded = result.entries.filter(entry => entry.action === 'create').length;
  assert.equal(result.lists.sheetShown, loaded - 1);
});

const STAFFED = { staffIncluded: true, signoffRefs: { keepStaff: 'so-staff' } };
const sheetEntry = (id, sheetKey, fields) => ({ id, effectiveFrom: null, effectiveTo: null, source: 'sheet', sheetKey, ...fields });

test('an open sheet staff entry the extract no longer carries is closed; a note is not', () => {
  const row = { id: PROJECT, staffAssignments: [sheetEntry('held-lead', 'register:lead', { role: 'lead', name: 'staff-value-1' })],
    staffNotes: [sheetEntry('held-note', 'register:notes', { text: 'staff-value-2' })] };
  const result = plan({ projects: [{ ...register, epd: 'staff-value-3' }] }, { row, flags: STAFFED });
  const closes = result.entries.filter(entry => entry.action === 'closeHistory');
  assert.deepEqual(closes.map(entry => [entry.field, entry.entryId, entry.effectiveTo]), [['staffAssignments', 'held-lead', '2026-11-13']]);
});

test('refuses closing sheet staff entries without a keepStaff sign-off ref', () => {
  const row = { id: PROJECT, staffAssignments: [sheetEntry('held-lead', 'register:lead', { role: 'lead', name: 'staff-value-1' })] };
  assert.throws(() => plan({ projects: [register] }, { row, flags: { staffIncluded: true, signoffRefs: { keepStaff: ' ' } } }), /keepStaff/);
});

test('real numbers need no keepNumbers ref when no external id is written', () => {
  const row = { id: PROJECT, externalIds: [{ system: 'eao-register', value: String(NUMBER), source: 'sheet' }] };
  const result = plan(amended, { row, flags: { numbersReal: true, signoffRefs: { keepNumbers: null } } });
  assert.equal(result.entries.filter(entry => entry.action === 'addExternalId').length, 0);
});

test('sheetShown leaves out an untilTrack sheet work a Track work replaces', () => {
  const sheet = { id: 'sheet-a', projectId: PROJECT, source: 'sheet', workTypeCode: 'amendment', startDate: '2025-02-01', decisionDate: null };
  const track = { id: 'track-9', projectId: PROJECT, source: 'track', workTypeId: 7, workState: 'IN_PROGRESS', startDate: '2025-02-03' };
  const marker = { projectId: PROJECT, active: true, hidden: [], untilTrack: ['sheet-a'], pairedTrackWorkIds: [] };
  const lists = listsOf({ loaded: [sheet], markers: [marker], trackWorks: new Map([[PROJECT, [track]]]), trackPublic: new Map(), report: [] });
  assert.equal(lists.sheetShown, 0);
});

test('a marker the load turns off lists no trackHidden pair', () => {
  const sheet = { id: 'sheet-a', projectId: PROJECT, source: 'sheet', workTypeCode: 'amendment', startDate: '2020-02-01', decisionDate: '2020-06-01' };
  const track = { id: 'track-9', projectId: PROJECT, source: 'track', workTypeId: 7, workState: 'COMPLETED', startDate: '2020-02-03', decisionDate: '2020-06-01' };
  const marker = { projectId: PROJECT, active: false, hidden: [{ trackWorkId: 'track-9', sheetWorkId: 'sheet-a' }], untilTrack: [], pairedTrackWorkIds: ['track-9'] };
  const lists = listsOf({ loaded: [sheet], markers: [marker], trackWorks: new Map([[PROJECT, [track]]]), trackPublic: new Map(), report: [] });
  assert.deepEqual(lists.trackHidden, []);
});
