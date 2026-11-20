'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { actOf, assessmentWorks, postDecisionWork, splitsOn2002 } = require('../../src/domain/business-works-assessment');
const { validateWork } = require('../../src/domain/work-model');
const { CATALOG, PHASES } = require('../helpers/business-works-fixtures');

const CTX = { catalog: CATALOG, phaseCatalog: PHASES, transitions: new Map(), batchId: 'batch-1' };
const BASE = { projectId: 'project-alpha', number: 101, title: 'Sample Mine', ref: { file: 'made-up.xlsx', sheet: 'Projects', row: 5 } };
const ACT_1996 = { actYear: 1996, actBasis: 'determination-type' };
const register = (fields) => ({
  id: 101, intakeType: 's.6', intakeDate: '2005-01-01', determinationType: 's.10(1)(c)', decision: 'EA Certificate Granted',
  decisionDate: '2008-05-01', ...fields
});
const recorder = () => {
  const listed = [];
  return { listed, list: (reason, extra = {}) => listed.push({ reason, ...extra }) };
};
const worksOf = (row, act = { actYear: 2002, actBasis: 'determination-type' }, transitions = new Map()) => {
  const { listed, list } = recorder();
  return { works: assessmentWorks({ ...CTX, transitions }, row, BASE, act, list), listed };
};
const phasesOf = (fields) => worksOf(register(fields)).works.at(-1).phases;
const codesOf = (phase) => phase.milestones.map(one => one.code);
const reasonsOf = (listed, reason) => listed.filter(one => one.reason === reason);

const amendments = (...specs) => {
  const { listed, list } = recorder();
  const project = { base: BASE, certificates: [{ actYear: 2002, day: '2008-05-01', unknown: false }], works: [] };
  specs.forEach(spec => postDecisionWork(CTX, project, { kind: 'amendment', code: 'amendment', ref: BASE.ref, ...spec }, list));
  return { works: project.works, listed };
};
const PRE_2002 = { intakeType: 'Pre-EAO', intakeDate: '1999-05-01', determinationType: 'Pre-2002 Act', determinationDate: '1999-07-10' };

test('s.6/s.11 dated 2022 is 2018; dated 1999 is 2002 and listed', () => {
  const { listed, list } = recorder();
  const undetermined = { determinationType: null, determinationDate: null };
  assert.strictEqual(actOf(CTX, { ...undetermined, intakeType: 's.6/s.11', intakeDate: '2022-03-01' }, list).actYear, 2018);
  assert.strictEqual(actOf(CTX, { ...undetermined, intakeType: 's.7/s.12', intakeDate: '2010-03-01' }, list).actYear, 2002);
  assert.deepStrictEqual(listed, []);
  assert.strictEqual(actOf(CTX, { ...undetermined, intakeType: 's.6/s.11', intakeDate: '1999-07-10' }, list).actYear, 2002);
  assert.deepStrictEqual(listed, [{ reason: 'intakeBeforeAct', field: 'intakeType' }]);
});

test('milestone-only phase does not exist', () => {
  const phases = phasesOf({ s11Order: '2005-06-01', start30: '2006-01-01' });
  assert.deepStrictEqual(phases.map(phase => phase.name), ['Pre-EA', 'Evaluation']);
  assert.deepStrictEqual(phases[0].milestones.map(one => one.code), ['intake', 's11-order']);
});

test('no Start (45) gives no Referral', () => {
  const last = phasesOf({ determinationDate: '2005-03-01', start180: '2007-01-01' }).at(-1);
  assert.strictEqual(last.name, 'Application Review');
  assert.strictEqual(last.endDate, '2008-05-01');
  assert.strictEqual(last.milestones.at(-1).code, 'decision');
});

test('row 138 shape keeps its work', () => {
  const { works, listed } = worksOf(register({
    id: 143, intakeDate: '2001-05-01', determinationType: 'Pre-2002 Act', determinationDate: '2002-12-30',
    start30: '2003-02-01', start180: '2002-02-06', start45: '2003-10-01', decisionDate: '2004-06-01'
  }), { actYear: 1996, actBasis: 'determination-type' });
  assert.deepStrictEqual(works.map(work => [work.actYear, validateWork(work).ok]), [[1996, true], [2002, true]]);
  assert.deepStrictEqual(listed.filter(one => one.reason === 'outOfOrderDate'), [{ reason: 'outOfOrderDate', field: 'start180' }]);
});

test('a Start (45) after the decision is dropped and listed', () => {
  const { works, listed } = worksOf(register({ start180: '2007-01-01', start45: '2008-06-01' }));
  assert.deepStrictEqual(works[0].phases.map(phase => [phase.name, phase.endDate]), [['Pre-EA', '2007-01-01'], ['Application Review', '2008-05-01']]);
  assert.ok(validateWork(works[0]).ok);
  assert.deepStrictEqual(listed, [{ reason: 'outOfOrderDate', field: 'start45' }]);
});

test('2002 Evaluation numberOfDays 30, legislated true', () => {
  const phases = phasesOf({ start30: '2006-01-01', start180: '2006-02-01', start45: '2007-08-01' });
  assert.deepStrictEqual(phases.map(phase => [phase.name, phase.numberOfDays, phase.legislated]), [
    ['Pre-EA', undefined, undefined], ['Evaluation', 30, true], ['Application Review', 180, true], ['Referral', 45, true]
  ]);
});

test('F.A.R. Yes gives a Further Assessment phase, last in order, with no dates', () => {
  const phases = phasesOf({ start45: '2007-08-01', far: 'Yes' });
  const last = phases.at(-1);
  assert.deepStrictEqual([last.name, last.sortOrder, last.startDate, last.endDate, Object.hasOwn(last, 'undated')],
    ['Further Assessment', phases.length - 1, null, null, false]);
  assert.strictEqual(phases.at(-2).milestones.at(-1).code, 'decision');
});

test('a milestone with no phase to hold it is listed', () => {
  const { works, listed } = worksOf(register({ intakeDate: null, s11Order: '2005-06-01' }));
  assert.deepStrictEqual(works[0].phases, []);
  assert.deepStrictEqual(reasonsOf(listed, 'milestoneNoPhase').map(one => one.milestone), ['s11-order', 'decision']);
});

test('055 shape splits and keeps the 2003 s.11 on the 2002 half', () => {
  const row = register({
    ...PRE_2002, id: 55, s11Order: '2003-08-18', airAccepted: '2003-04-01', start30: '2004-03-01', start180: '2004-04-01',
    start45: '2004-10-01', decisionDate: '2004-11-15', timeline2002: true
  });
  assert.strictEqual(splitsOn2002(CTX, row), true);
  const [old, fresh] = worksOf(row, ACT_1996).works;
  assert.deepStrictEqual([old.actYear, fresh.actYear, old.simpleTitle, fresh.simpleTitle], [1996, 2002, '1996 Act', '2002 Act']);
  const [oldPre, freshPre] = [old, fresh].map(work => work.phases.find(phase => phase.name === 'Pre-Application'));
  assert.deepStrictEqual([oldPre.startDate, oldPre.endDate, codesOf(oldPre)], ['1999-07-10', '2002-12-30', ['act-transition']]);
  assert.deepStrictEqual([freshPre.startDate, freshPre.endDate, codesOf(freshPre)],
    ['2002-12-30', '2004-03-01', ['act-transition', 's11-order', 'air-accepted']]);
  assert.strictEqual(fresh.phases.find(phase => phase.name === 'Evaluation').numberOfDays, 30);
  assert.deepStrictEqual([old.certificateKind, fresh.certificateKind, fresh.decisionDate], [undefined, 'EAC', '2004-11-15']);
  assert.deepStrictEqual([old, fresh].map(work => validateWork(work).ok), [true, true]);
});

test('018 shape with no timeline flag stays one 1996 work', () => {
  const { works } = worksOf(register({
    intakeType: 'Pre-EAO', intakeDate: '1995-06-30', determinationType: 'Pre-2002 Act', determinationDate: '1995-06-30',
    start30: '2003-12-30', start180: '2004-02-05', start45: '2004-08-03', decisionDate: '2004-10-12'
  }), ACT_1996);
  assert.deepStrictEqual(works.map(work => [work.actYear, work.certificateKind]), [[1996, 'EAC']]);
});

test('row 49 shape: a transition on 2020-02-21 leaves a transitioned 2002 work with no certificate', () => {
  const row = register({
    id: 482, intakeType: '2018 Act', intakeDate: '2019-06-07', determinationDate: '2019-10-29', start30: '2021-01-10',
    start180: '2021-03-01', start45: '2023-06-01', decisionDate: '2023-10-10'
  });
  const [work, ...more] = worksOf(row, undefined, new Map([[482, { id: 482, date: '2020-02-21' }]])).works;
  assert.deepStrictEqual(more, []);
  assert.deepStrictEqual([work.actYear, work.workState, work.decisionDate, work.certificateKind, work.transitionOut.date],
    [2002, 'transitioned', null, undefined, '2020-02-21']);
  assert.strictEqual(work.phases.at(-1).endDate, '2020-02-21');
});

test('decision 2025-05-02 keeps outcome withdrawn', () => {
  const { works, listed } = worksOf(register({ start30: '2024-06-01', decision: 'Withdrawn', decisionDate: '2025-05-02' }));
  assert.deepStrictEqual([works[0].outcomeCode, works[0].workState, works[0].decisionDate, works[0].phases.at(-1).endDate],
    ['withdrawn', 'withdrawn', '2025-05-02', '2025-05-02']);
  assert.deepStrictEqual(reasonsOf(listed, 'decisionAfterTrackFrom').length, 1);
  assert.deepStrictEqual(reasonsOf(listed, 'afterTrackFrom'), []);
});

test('row 130 shape (ID 480): a 2025-06-17 grant after a 2022-08-23 transition is still dropped, no certificate', () => {
  const row = register({ id: 480, intakeDate: '2019-01-15', determinationDate: '2019-05-01', start30: '2021-02-01', decisionDate: '2025-06-17' });
  const { works, listed } = worksOf(row, undefined, new Map([[480, { id: 480, date: '2022-08-23' }]]));
  assert.deepStrictEqual([works[0].workState, works[0].decisionDate, works[0].certificateKind], ['transitioned', null, undefined]);
  assert.deepStrictEqual(reasonsOf(listed, 'decisionAfterTrackFrom'), []);
});

test('same-day amendment finds its certificate', () => {
  const { works, listed } = amendments({ slot: 1, startDay: '2008-05-01', decisionDay: '2008-09-01' });
  assert.deepStrictEqual([works.length, works[0].actYear, reasonsOf(listed, 'no-certificate')], [1, 2002, []]);
});

test('In Progress with an end date is completed', () => {
  const { works, listed } = amendments({ slot: 1, startDay: '2009-01-01', decisionDay: '2009-03-01', status: 'In Progress' },
    { slot: 2, startDay: '2009-01-01', decisionDay: '2009-03-01', status: 'Withdrawn' });
  assert.deepStrictEqual(works.map(work => [work.workState, work.isActive]), [['completed', false], ['withdrawn', false]]);
  assert.deepStrictEqual(reasonsOf(listed, 'statusDisagrees'), [{ reason: 'statusDisagrees', field: 'status', code: 'in-progress' }]);
});

test('two amendments get different simpleTitle', () => {
  const { works } = amendments({ slot: 1, startDay: '2009-01-01' }, { slot: 2, startDay: '2010-01-01' });
  assert.deepStrictEqual(works.map(work => work.simpleTitle), ['#01', '#02']);
});
