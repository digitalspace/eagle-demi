'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  workDocOf, publicWorksOf, trackWorkToPublic, phaseEventsOf, withoutAdded, MIRRORED_WORK_TYPE_IDS
} = require('../../src/seed/track-mappers');
const { TRACK_WORK_TYPE_CODES, summaryOf } = require('../../src/domain/work-model');
const { applyEvent } = require('../../src/merge/track-record');

/** Track's nested work, two phases listed out of order, a HIDDEN event and a decision in each phase. */
const nestedWork = () => structuredClone(require('../fixtures/track-records/new_work_two_phases.json').work);

const ROW = { sources: { track: { name: 'North Mine' } } };

test('a stored work document reads back as the public work the nightly builds from the same Track data', () => {
  // Track's `/works` rows carry the title its `generate_title` built; the push leaves it out.
  const work = { ...nestedWork(), title: 'North Mine - Assessment - North Pit' };

  const [composed] = publicWorksOf([workDocOf(work, { projectId: 'p-1' })], ROW);

  assert.deepStrictEqual(withoutAdded({ works: [composed] }).works[0], trackWorkToPublic(work, phaseEventsOf(work)));
  assert.strictEqual(composed.outcome, 'Proceed', 'the END outcome of the last phase, not the earlier one');
});

test('a work with no simple title is titled by project name and work type alone', () => {
  const work = { ...nestedWork(), simple_title: '' };

  const [composed] = publicWorksOf([workDocOf(work)], ROW);

  assert.strictEqual(composed.title, 'North Mine - Assessment');
});

test('each milestone stays under its phase in the stored document', () => {
  const doc = workDocOf(nestedWork());

  assert.deepStrictEqual(doc.phases.map(p => [p.trackPhaseId, p.milestones.map(m => m.trackEventId)]),
    [[3001, [4001, 4003]], [3002, [4004, 4005]]], 'by sort order, the HIDDEN event 4002 left out');
});

test('a phase the catalog lacks keeps Track name and sort order, with no stage', () => {
  const [composed] = publicWorksOf([workDocOf(nestedWork())], ROW);

  assert.deepStrictEqual(composed.phases.map(p => [p.catalogId, p.catalogName, p.stage, p.order]),
    [['track-6001', 'Effects Assessment', null, 1], ['track-6002', 'Readiness Decision', null, 2]]);
});

test('a phase the catalog holds reads its id, name, stage and order from the entry', () => {
  const catalog = { 2018: [{ catalogId: 'list-1', name: 'Effects Assessment and Review', stage: 'Assessment',
    order: 4, trackPhaseCodeIds: [6001] }] };

  const [composed] = publicWorksOf([workDocOf(nestedWork())], ROW, { catalog });

  assert.deepStrictEqual(composed.phases[0], { ...composed.phases[0], catalogId: 'list-1',
    catalogName: 'Effects Assessment and Review', stage: 'Assessment', order: 4 });
  assert.strictEqual(composed.phases[0].name, 'Effects Assessment', 'the shown name stays Track\'s');
});

test('suspension is carried to the public phase', () => {
  const [composed] = publicWorksOf([workDocOf(nestedWork())], ROW);

  assert.deepStrictEqual(composed.phases.map(p => [p.isSuspended, p.suspendedDate]),
    [[false, null], [true, '2024-05-01T07:00:00.000Z']]);
});

test('a tombstoned work is left out of the public works', () => {
  const live = workDocOf(nestedWork());
  const tombstone = { id: 'track-2000', trackWorkId: 2000, workTypeId: 6, deleted: true, pushStamps: {} };

  assert.deepStrictEqual(publicWorksOf([tombstone, live], ROW).map(w => w.trackWorkId), [2001]);
});

const SHEET_REF = { sheet: { file: 'works.xlsx', sheet: 'Assessments', row: 7, slot: 1 } };
const sheetId = (n) => `sheet-00000000-0000-4000-8000-00000000000${n}`;

/** A made-up sheet work in the stored shape, private keys and stray Track ids at every level. */
const sheetDoc = (n = 1, overrides = {}) => ({
  id: sheetId(n), projectId: '1001', source: 'sheet', owner: 'sheet', schemaVersion: 1, trackWorkId: 9, workTypeId: 6,
  workTypeCode: 'assessment', workType: 'Assessment', actYear: 2002, startDate: '2003-02-01', decisionDate: null,
  isActive: false, workState: 'transitioned', outcomeCode: null, outcome: null,
  sourceKey: '12:assessment:1', sourceRef: SHEET_REF, provenance: { writtenBy: 'loader', batchId: 'b-1' },
  transitionIn: { fromActYear: 1996, date: '2003-02-01' },
  undated: { decisionDate: { notAfter: '1995-06-30', sourceRef: SHEET_REF } },
  phases: [{
    id: 'pre-application', catalogId: 'list-9', name: 'Pre-Application', sourceName: 'pre app (as typed)',
    startDate: '2003-02-01', endDate: '2004-01-01', sortOrder: 1, isCompleted: true, sourceRef: SHEET_REF,
    trackPhaseId: 3001, phaseCodeId: 6001, isSuspended: true,
    undated: { startDate: { notAfter: '1995-06-30' } },
    milestones: [{ id: 'act-transition', code: 'act-transition', name: 'Act transition', position: 'END', trackEventId: 4001,
      actualDate: '2004-01-01', anticipatedDate: null, endDate: null, outcomeCode: null, sourceRef: SHEET_REF,
      links: { commentPeriodId: 'cp-1', blockField: 'decision', eagleItemId: 'e-9' },
      undated: { anticipatedDate: { notAfter: '1995-06-30' } } }],
    interruptions: [{ id: 'suspension', kind: 'suspension', typeCode: 'proponent-request', legalSection: 's. 30',
      startDate: '2003-05-01', endDate: '2003-06-01', days: 31, links: { eagleItemId: 'e-1' }, sourceRef: SHEET_REF }]
  }],
  ...overrides
});

/** The nested Track work with a "Project Transitioning FROM" milestone naming the 2002 Act. */
function transitionedTrackWork() {
  const work = nestedWork();
  work.phases[0].events.push({ id: 4090, work_id: 2001, work_phase_id: 3001, name: 'Transition',
    actual_date: '2020-03-10T07:00:00+00:00', event_configuration: { id: 5090,
      name: 'Project Transitioning FROM the EA Act (2002)', event_position: 'START', sort_order: 9 } });
  return work;
}

const TRANSITION_OUT = { toActYear: 2018, date: '2019-12-20', dateSource: 'track' };

test('Track work carries workTypeCode and actYear', () => {
  const amendment = { ...nestedWork(), work_type_id: 16, work_type: { id: 16, name: 'Joint Complex Amendment' },
    ea_act: { id: 2, name: 'EA Act (2002)' } };

  assert.deepStrictEqual([workDocOf(nestedWork()), workDocOf(amendment)].map(d => [d.workTypeCode, d.actYear]),
    [['assessment', 2018], ['amendment', 2002]]);
  const { workTypeCode, actYear, ...unstamped } = workDocOf(amendment);
  const [read] = publicWorksOf([unstamped], ROW);
  assert.deepStrictEqual([read.workTypeCode, read.actYear], [workTypeCode, actYear], 'a document the nightly has not rewritten');
});

test('TRACK_WORK_TYPE_CODES keys equal MIRRORED_WORK_TYPE_IDS', () => {
  assert.deepStrictEqual(Object.keys(TRACK_WORK_TYPE_CODES).map(Number).sort((a, b) => a - b),
    [...MIRRORED_WORK_TYPE_IDS].sort((a, b) => a - b));
});

test('Track-only works keep today\'s order', () => {
  const later = workDocOf({ ...nestedWork(), id: 15, start_date: '2025-03-01T08:00:00+00:00' });

  assert.deepStrictEqual(publicWorksOf([workDocOf(nestedWork()), later], ROW).map(w => w.trackWorkId), [15, 2001]);
});

test('sheet work sorts after Track works by startDate', () => {
  const late = sheetDoc(2, { startDate: '2010-05-01', phases: undefined });

  const order = publicWorksOf([late, workDocOf(nestedWork()), sheetDoc(1)], ROW).map(w => w.workId);

  assert.deepStrictEqual(order, ['track-2001', sheetId(1), sheetId(2)]);
});

test('sheet phase gets its stored catalogId', () => {
  const catalog = { 2002: [{ catalogId: 'list-9', name: 'Pre-Application Phase', stage: 'Pre-Application', order: 2 }] };

  const [bare] = publicWorksOf([sheetDoc()], ROW);
  const [named] = publicWorksOf([sheetDoc()], ROW, { catalog });

  assert.deepStrictEqual([bare.phases[0].catalogId, bare.phases[0].name], ['list-9', 'Pre-Application']);
  assert.deepStrictEqual([named.phases[0].name, named.phases[0].stage], ['Pre-Application Phase', 'Pre-Application']);
  assert.deepStrictEqual([bare.trackWorkId, bare.workTypeId, bare.phases[0].trackPhaseId, bare.phases[0].phaseCodeId,
    bare.phases[0].isSuspended, bare.milestones[0].trackEventId], [null, null, null, null, null, null], 'Track-only keys');
});

test('a sheet work on a project with no Track source is titled by the row\'s name', () => {
  const [work] = publicWorksOf([sheetDoc()], { name: 'Old Quarry', sources: {} });

  assert.strictEqual(work.title, 'Old Quarry - Assessment');
});

test('event push recomputes summary', () => {
  const stored = { ...workDocOf(nestedWork(), { projectId: '1001' }), summary: { elapsedDays: 999 } };
  const event = { id: 4010, work_id: 2001, work_phase_id: 3002, name: 'Notice', actual_date: '2024-05-20T07:00:00+00:00',
    event_configuration: { id: 5010, name: 'Notice', event_position: 'INTERMEDIATE', sort_order: 3 } };

  const { doc } = applyEvent(stored, { pushedAt: Date.now(), event });

  assert.deepStrictEqual(doc.summary, summaryOf(doc));
});

test('exact key set at work, phase, milestone, interruption and links level', () => {
  const keys = (obj) => Object.keys(obj).sort();
  const today = ['trackWorkId', 'workTypeId', 'workType', 'title', 'eaAct', 'startDate', 'isActive', 'workState',
    'decisionDate', 'anticipatedDecisionDate', 'outcome', 'phases', 'milestones'];
  const work = [...today, 'workId', 'source', 'actYear', 'workTypeCode', 'outcomeCode', 'transitionOut', 'undated'];
  const phase = ['name', 'eaActId', 'eaActName', 'workType', 'startDate', 'endDate', 'numberOfDays', 'legislated',
    'sortOrder', 'isCompleted', 'trackPhaseId', 'phaseCodeId', 'catalogId', 'catalogName', 'stage', 'order',
    'isSuspended', 'suspendedDate', 'undated', 'interruptions'];
  const milestone = ['name', 'position', 'eventType', 'actualDate', 'anticipatedDate', 'outcome', 'numberOfDays',
    'trackEventId', 'code', 'endDate', 'links', 'undated'];

  const works = publicWorksOf([workDocOf(nestedWork()), sheetDoc()], ROW);

  for (const one of works) {
    assert.deepStrictEqual(keys(one), [...work].sort(), one.workId);
    for (const p of one.phases) assert.deepStrictEqual(keys(p), [...phase].sort(), one.workId);
    for (const m of one.milestones) {
      assert.deepStrictEqual(keys(m), [...milestone].sort(), one.workId);
      assert.deepStrictEqual(keys(m.links), ['blockField', 'commentPeriodId'], one.workId);
    }
  }
  assert.deepStrictEqual(keys(works[1].phases[0].interruptions[0]),
    ['days', 'endDate', 'id', 'kind', 'legalSection', 'startDate', 'typeCode']);
});

test('transitionOut and undated pass through; transitionIn does not', () => {
  const transitionOut = { toActYear: 2018, date: '2010-04-01', dateSource: 'sheet' };

  const doc = sheetDoc(1, { transitionOut });
  doc.phases[0].milestones.push({ id: 'odd', undated: [{ notAfter: '1995-06-30' }] });
  doc.phases[0].undated.endDate = { notAfter: 19950630 };

  const [work] = publicWorksOf([doc], ROW);

  assert.deepStrictEqual(work.transitionOut, transitionOut);
  assert.deepStrictEqual([work.undated, work.phases[0].undated, ...work.milestones.map(m => m.undated)], [
    { decisionDate: { notAfter: '1995-06-30' } }, { startDate: { notAfter: '1995-06-30' }, endDate: { notAfter: null } },
    { anticipatedDate: { notAfter: '1995-06-30' } }, null]);
  assert.ok(!('transitionIn' in work));
});

test('a Track transition milestone stored under phases[].milestones resolves the 477 date in publicWorksOf output', () => {
  const docs = [workDocOf(transitionedTrackWork()), sheetDoc(1, { transitionOut: TRANSITION_OUT })];

  const sheet = publicWorksOf(docs, ROW).find(w => w.source === 'sheet');

  assert.deepStrictEqual(sheet.transitionOut, { toActYear: 2018, date: '2020-03-10', dateSource: 'track' });
});

test('477 publishes Track\'s transition date when Track\'s milestone exists, else the sheet fallback', () => {
  const docs = [workDocOf(nestedWork()), sheetDoc(1, { transitionOut: TRANSITION_OUT })];

  const sheet = publicWorksOf(docs, ROW).find(w => w.source === 'sheet');

  assert.deepStrictEqual(sheet.transitionOut, { toActYear: 2018, date: '2019-12-20', dateSource: 'sheet' },
    'no Track milestone: the stored sheet date');
});

test('no provenance, sourceKey or sourceRef key in publicWorksOf output', () => {
  const track = { ...workDocOf(nestedWork()), sourceRef: { track: { workId: 2001 } }, provenance: { writtenBy: 'push' } };
  const sheet = sheetDoc(1, { transitionOut: { ...TRANSITION_OUT, sourceRef: SHEET_REF } });
  const seen = new Set();

  JSON.stringify(publicWorksOf([track, sheet], ROW), (key, value) => { seen.add(key); return value; });

  assert.deepStrictEqual(['provenance', 'sourceKey', 'sourceRef', 'transitionIn', 'sourceName'].filter(k => seen.has(k)), []);
});
