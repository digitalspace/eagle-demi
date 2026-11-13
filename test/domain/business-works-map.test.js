'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { mapBusinessWorks } = require('../../src/domain/business-works-map');
const MAP = require('../../src/data/works-catalog-map.json');
const PHASE_MAP = require('../../src/data/phase-catalog-map.json');

// The catalogs as build-works-catalog.js resolves them, with made-up phase ids.
const phaseId = (year, name) => `${year}:${name}`;
const CATALOG = {
  ...MAP, appliedTo: MAP.appliedTo.map(entry => ({ ...entry, catalogIds: { 1996: phaseId(1996, entry.phase), 2002: phaseId(2002, entry.phase) } }))
};
const PHASES = Object.fromEntries([1996, 2002].map(year =>
  [year, PHASE_MAP.acts[year].map(entry => ({ ...entry, catalogId: phaseId(year, entry.name) }))]));

const PROJECT = 'project-alpha';
const ref = (sheet, slot) => ({ file: 'made-up.xlsx', sheet, row: 5, ...(slot && { slot }) });
const register = (fields) => ({
  ref: ref('Projects'), id: 101, name: 'Sample Mine', intakeType: 's.6', intakeDate: '2005-01-01',
  determinationType: 's.10(1)(c)', determinationDate: '2005-03-01', decision: 'EA Certificate Granted',
  decisionDate: '2008-05-01', ...fields
});
const amendment = (slot, startDate, endDate) => ({ ref: ref('Amendments', slot), id: 101, name: 'Sample Mine', startDate, endDate });
const trackWork = (n, fields) => ({
  id: `track-${n}`, projectId: PROJECT, workTypeId: 7, workState: 'IN_PROGRESS', startDate: null, decisionDate: null, ...fields
});
const decided2018 = trackWork(900, { workTypeId: 6, workState: 'COMPLETED', startDate: '2020-03-01', decisionDate: '2023-10-10' });

const run = (records, options = {}) => mapBusinessWorks({ records: { projects: [register()], ...records } }, {
  catalog: CATALOG, phaseCatalog: PHASES, crosswalk: new Map([[101, PROJECT], [8, 'project-eight']]),
  batchId: 'batch-1', batchAt: '2026-11-13T18:00:00Z', ...options
});
const withTrack = (records, trackWorks) => run(records, { trackWorks: new Map([[PROJECT, trackWorks]]) });
const reasons = (result, reason) => result.report.filter(entry => entry.reason === reason);
const work = (result, sourceKey) => result.works.find(one => one.sourceKey === sourceKey);
const assessments = (result) => result.works.filter(one => one.workTypeCode === 'assessment');
const milestones = (one) => one.phases.flatMap(phase => phase.milestones);
const marker = (result) => result.markers[0];

test('the 2018 Act decision in Track sets the boundary: an amendment closed before it loads, one after is skipped', () => {
  const result = withTrack({ amendments: [amendment(1, '2023-08-01', '2023-09-01'), amendment(2, '2023-10-20', '2023-11-01')] },
    [decided2018, trackWork(31, { startDate: '2023-10-21', decisionDate: '2023-11-02', workState: 'COMPLETED' })]);
  assert.strictEqual(marker(result).boundaryAtLoad, '2023-10-10');
  assert.ok(work(result, '101:amendment:1'));
  assert.strictEqual(work(result, '101:amendment:2'), undefined);
  assert.deepStrictEqual(reasons(result, 'afterBoundary').map(entry => [entry.sourceKey, entry.closed]), [['101:amendment:2', 'closedAfter']]);
});

test('a project with no 1996 or 2002 certificate gets no marker', () => {
  assert.deepStrictEqual(run({ projects: [register({ decision: 'EA Certificate Refused' })] }).markers, []);
});

test('an open sheet amendment paired with a decided Track amendment is skipped open, naming that Track work', () => {
  const result = withTrack({ amendments: [amendment(1, '2024-11-01', null)] },
    [trackWork(40, { startDate: '2024-11-03', decisionDate: '2024-06-01', workState: 'COMPLETED' })]);
  assert.strictEqual(work(result, '101:amendment:1'), undefined);
  assert.deepStrictEqual(marker(result).hidden, []);
  const [entry] = reasons(result, 'afterBoundary');
  assert.deepStrictEqual([entry.closed, entry.trackWorkId], ['open', 'track-40']);
});

test('an unpaired open sheet amendment loads and is listed untilTrack', () => {
  const result = run({ amendments: [amendment(1, '2023-10-25', null)] });
  assert.ok(work(result, '101:amendment:1'));
  assert.deepStrictEqual(marker(result).untilTrack, ['101:amendment:1']);
});

test('a COMPLETED Track amendment with no date paired with a kept sheet amendment is hidden and listed', () => {
  const result = withTrack({ amendments: [amendment(1, '2020-01-10', '2020-06-01')] },
    [trackWork(41, { startDate: '2020-01-20', workState: 'COMPLETED' })]);
  assert.deepStrictEqual(marker(result).hidden, [{ trackWorkId: 'track-41', sourceKey: '101:amendment:1' }]);
  assert.strictEqual(reasons(result, 'trackCompletedNoDate').length, 1);
});

test('a kept sheet amendment whose Track twin is still open is skipped as trackAlive', () => {
  const result = withTrack({ amendments: [amendment(1, '2018-10-29', '2021-02-12')] }, [trackWork(42, { startDate: '2018-10-29' })]);
  assert.strictEqual(work(result, '101:amendment:1'), undefined);
  assert.deepStrictEqual(marker(result).trackAlive, [{ trackWorkId: 'track-42', sourceKey: '101:amendment:1' }]);
});

test('a Track amendment decided the day a kept sheet amendment closed goes in a hidden pair', () => {
  const result = withTrack({ amendments: [amendment(1, '2023-06-01', '2023-11-07')] },
    [trackWork(43, { startDate: '2023-03-01', decisionDate: '2023-11-07', workState: 'COMPLETED' })]);
  assert.deepStrictEqual(marker(result).hidden, [{ trackWorkId: 'track-43', sourceKey: '101:amendment:1' }]);
  assert.deepStrictEqual(marker(result).pairedTrackWorkIds, ['track-43']);
});

test('a Track work paired with a kept sheet work is not named by an afterBoundary entry; that work loads untilTrack', () => {
  const result = withTrack({ amendments: [amendment(1, '2023-08-01', '2023-09-01'), amendment(2, '2023-08-10', null)] },
    [trackWork(44, { startDate: '2023-08-02', decisionDate: '2023-09-01', workState: 'COMPLETED' })]);
  assert.deepStrictEqual(marker(result).untilTrack, ['101:amendment:2']);
  assert.ok(work(result, '101:amendment:2'));
});

test('a Pre-EAO certificate decided on the unknown-date placeholder gets a marker', () => {
  const result = run({ projects: [register({ intakeType: 'Pre-EAO', determinationType: 'Pre-EAO', intakeDate: '1995-06-30', determinationDate: null, decisionDate: '1995-06-30' })] });
  assert.deepStrictEqual(marker(result).certificates, [{ actYear: 1996, certificateKind: 'EAC', decisionDate: null }]);
});

test('a re-run keeps an inactive marker off and reports overrideHeldOff', () => {
  const result = run({}, { markers: new Map([[PROJECT, { active: false }]]) });
  assert.strictEqual(marker(result).active, false);
  assert.strictEqual(reasons(result, 'overrideHeldOff').length, 1);
});

test('a PA certificate row that meets the split rule stays one 1996 work and is listed pac-1996', () => {
  const result = run({ projects: [register({ intakeType: null, intakeDate: '1999-04-01', determinationType: 'Pre-2002 Act', determinationDate: '2002-12-30', decision: 'PA Certificate Granted', decisionDate: '2003-05-08' })] });
  assert.deepStrictEqual(assessments(result).map(one => [one.actYear, one.certificateKind]), [[1996, 'PAC']]);
  assert.strictEqual(reasons(result, 'pac-1996').length, 1);
});

test('PA Certificate Granted sets 1996 when determination and intake types do not', () => {
  const result = run({ projects: [register({ intakeType: null, determinationType: null, decision: 'PA Certificate Granted' })] });
  assert.deepStrictEqual(assessments(result).map(one => [one.actYear, one.actBasis]), [[1996, 'decision-type']]);
});

test('sheet ID 8 writes no capitalInvestments entry and is listed investmentUseTrack', () => {
  const result = run({ projects: [register({ id: 8, investment: 85000000 })] });
  assert.deepStrictEqual(result.projects[0].capitalInvestments, []);
  assert.strictEqual(reasons(result, 'investmentUseTrack').length, 1);
});

test('an investment loads as written', () => {
  const [entry] = run({ projects: [register({ investment: 897700000000 })] }).projects[0].capitalInvestments;
  assert.deepStrictEqual([entry.amountCad, entry.source, entry.effectiveFrom], [897700000000, 'sheet', null]);
});

test('EPD and Lead become one entry each, observed on the batch day, keyed without the register number', () => {
  const { staffAssignments } = run({ projects: [register({ epd: 'Made Up', lead: 'Also Made' })] }).projects[0];
  assert.deepStrictEqual(staffAssignments.map(one => [one.role, one.effectiveFrom, one.source, one.observedAt, one.sheetKey]),
    [['epd', null, 'sheet', '2026-11-13', 'register:epd'], ['lead', null, 'sheet', '2026-11-13', 'register:lead']]);
});

test('Notes become a staffNotes entry, never a work key', () => {
  const result = run({ projects: [register({ notes: 'first line\nsecond line' })] });
  assert.deepStrictEqual(result.projects[0].staffNotes.map(one => [one.text, one.observedAt]), [['first line second line', '2026-11-13']]);
  assert.ok(!JSON.stringify(result.works).includes('first line'));
});

test('a title with line breaks is collapsed to one line', () => {
  assert.strictEqual(assessments(run({ projects: [register({ name: 'Sample\n  Mine' })] }))[0].title, 'Sample Mine');
});

test('a Transition Order before 2025 ends the 2002 work on its date and lists later milestones', () => {
  const result = run({ projects: [register({ decision: 'Incomplete/Inactive', decisionDate: null, start180: '2023-01-01' })], transitions: [{ ref: ref('EA Process Data'), id: 101, date: '2022-08-23' }] },
    { transitionIdsAreRegisterIds: true });
  const [only] = assessments(result);
  assert.deepStrictEqual([only.workState, only.transitionOut], ['transitioned', { toActYear: 2018, date: '2022-08-23', dateSource: 'sheet' }]);
  assert.deepStrictEqual(milestones(only).filter(one => one.code === 'act-transition').map(one => [one.position, one.actualDate]), [['END', '2022-08-23']]);
  assert.deepStrictEqual(reasons(result, 'afterTransition').map(entry => entry.milestone), ['review-start']);
});

test('a Transition Order dated in 2025 keeps the sheet date with dateSource track', () => {
  const result = run({ projects: [register({ decision: null, decisionDate: null })], transitions: [{ ref: ref('EA Process Data'), id: 101, date: '2025-05-21' }] },
    { transitionIdsAreRegisterIds: true });
  assert.deepStrictEqual(assessments(result)[0].transitionOut, { toActYear: 2018, date: '2025-05-21', dateSource: 'track' });
});

test('a Transition Order with no date gives dateSource none and no cut', () => {
  const result = run({ projects: [register({ decision: null, decisionDate: null })], transitions: [{ ref: ref('EA Process Data'), id: 101, date: null }] },
    { transitionIdsAreRegisterIds: true });
  const [only] = assessments(result);
  assert.deepStrictEqual(only.transitionOut, { toActYear: 2018, date: null, dateSource: 'none' });
  assert.ok(!milestones(only).some(one => one.code === 'act-transition'));
});

test('transitions are not joined until the caller says what column A holds', () => {
  const result = run({ projects: [register({ decision: null, decisionDate: null })], transitions: [{ ref: ref('EA Process Data'), id: 101, date: '2022-08-23' }] });
  assert.strictEqual(assessments(result)[0].transitionOut, undefined);
  assert.strictEqual(reasons(result, 'transitionJoinUndecided').length, 1);
});

test('a Pre-2002 Act determination on the 2002 in-force day after an earlier intake splits the row in two', () => {
  const result = run({ projects: [register({ intakeDate: '2001-02-01', determinationType: 'Pre-2002 Act', determinationDate: '2002-12-30', start180: '2004-01-01' })] });
  const [early, late] = assessments(result);
  assert.deepStrictEqual([early.actYear, early.transitionOut, early.decisionDate], [1996, { toActYear: 2002, date: '2002-12-30', dateSource: 'sheet' }, null]);
  assert.deepStrictEqual([late.actYear, late.startDate, late.transitionIn, late.decisionDate], [2002, '2002-12-30', { fromActYear: 1996, date: '2002-12-30' }, '2008-05-01']);
  assert.deepStrictEqual(late.phases.map(phase => phase.catalogId)[0], '2002:Pre-Application');
});

test('Timelines 2002 milestones of a row open across 2002 land on its 1996 work and are listed', () => {
  const result = run({ projects: [register({ intakeType: 'Pre-EAO', determinationType: 'Pre-EAO', intakeDate: '2001-02-01', determinationDate: '2001-06-01', decision: null, decisionDate: null })],
    timeline2002: [{ ref: ref('2002'), name: 'SAMPLE  mine', start180: '2004-03-01' }] });
  const [only] = assessments(result);
  assert.strictEqual(only.actYear, 1996);
  assert.ok(milestones(only).some(one => one.code === 'review-start' && one.actualDate === '2004-03-01'));
  assert.deepStrictEqual(['open-across-2002', 'sheet-2002-on-1996-work'].map(reason => reasons(result, reason).length), [1, 1]);
});

test('2018 rows are skipped with a reason', () => {
  const result = run({ projects: [register({ determinationType: 'IPD Accepted', determinationDate: '2021-01-01' })] });
  assert.deepStrictEqual(assessments(result), []);
  assert.strictEqual(reasons(result, 'act2018').length, 1);
});

test('an intake typed 2018 Act with an s.10 determination is a 2002 work', () => {
  const result = run({ projects: [register({ intakeType: '2018 Act', determinationType: 's.10(1)(c)' })] });
  assert.strictEqual(assessments(result)[0].actYear, 2002);
});

test('a milestone dated on or after 2025-01-01 is dropped and listed', () => {
  const result = run({ projects: [register({ decision: null, decisionDate: null, start45: '2025-02-01' })] });
  assert.ok(!milestones(assessments(result)[0]).some(one => one.code === 'referral-start'));
  assert.strictEqual(reasons(result, 'afterTrackFrom').length, 1);
});

test('the unknown-date placeholder in intake is stored as unknown', () => {
  const [only] = assessments(run({ projects: [register({ intakeDate: '1995-06-30' })] }));
  assert.deepStrictEqual([only.startDate, only.undated], [null, { startDate: { notAfter: '1995-06-30' } }]);
});

test('a decision label in neither outcomes nor work states is listed, and the work closes with no outcome', () => {
  const result = run({ projects: [register({ decision: 'Made Up Ruling' })] });
  const [only] = assessments(result);
  assert.deepStrictEqual([only.outcomeCode, only.workState, only.decisionDate], [null, 'completed', '2008-05-01']);
  assert.strictEqual(reasons(result, 'unknownDecision').length, 1);
});

test('a decision label in both lists reads as an outcome first', () => {
  const [only] = assessments(run({ projects: [register({ decision: 'Withdrawn' })] }));
  assert.deepStrictEqual([only.outcomeCode, only.workState], ['withdrawn', 'withdrawn']);
});

test('Incomplete/Inactive is a work state, not an outcome', () => {
  const [only] = assessments(run({ projects: [register({ decision: 'Incomplete/Inactive' })] }));
  assert.deepStrictEqual([only.workState, only.outcomeCode, only.isActive], ['inactive', null, false]);
});

test('an amendment on a certificate the 2018 Act issued is skipped as Track\'s', () => {
  const result = run({ projects: [register({ determinationType: 'IPD Accepted', decisionDate: '2022-01-01' })], amendments: [amendment(1, '2023-01-01', '2023-02-01')] });
  assert.strictEqual(reasons(result, 'onCertificate2018').length, 1);
});

test('an amendment with no certificate before it is listed no-certificate', () => {
  const result = run({ amendments: [amendment(1, '2007-01-01', '2007-02-01')] });
  assert.strictEqual(work(result, '101:amendment:1'), undefined);
  assert.strictEqual(reasons(result, 'no-certificate').length, 1);
});

test('a substantial start is built only when the caller says how to read the sheet', () => {
  const records = { projects: [register({ substantialStartDate: '2012-01-01' })] };
  assert.strictEqual(reasons(run(records), 'substantialStartUndecided').length, 1);
  const started = work(run(records, { substantialStart: () => true }), '101:register:substantial-start');
  assert.deepStrictEqual([started.actYear, started.actBasis, started.decisionDate], [2002, 'certificate', '2012-01-01']);
});

test('a suspension lands on the phase its Applied-To label names', () => {
  const result = run({ projects: [register({ start180: '2006-01-01', start45: '2007-01-01' })],
    suspensions: [{ ref: ref('Suspensions', 1), id: 101, type: 'Suspension s.24(2)', appliedTo: 'Review', startDate: '2006-02-01', endDate: '2006-03-01' }] });
  const holder = assessments(result)[0].phases.find(phase => phase.interruptions.length);
  assert.deepStrictEqual([holder.name, holder.interruptions[0].days, holder.interruptions[0].legalSection], ['Application Review', 28, 's.24(2)']);
});

test('an Other interruption takes its kind from the tab it was read on', () => {
  const result = run({ projects: [register({ start180: '2006-01-01' })],
    extensions: [{ ref: ref('Extensions', 1), id: 101, type: 'Other', appliedTo: 'Review', startDate: '2006-02-01', endDate: '2006-03-01' }] });
  assert.strictEqual(assessments(result)[0].phases.flatMap(phase => phase.interruptions)[0].kind, 'extension');
});

test('a comment period becomes a range milestone on the work and phase holding its start', () => {
  const result = run({ commentPeriods: [{ ref: ref('PCPs', 1), id: 101, type: 'Application PCP', startDate: '2005-02-01', endDate: '2005-02-28' }] });
  const holder = assessments(result)[0].phases.find(phase => phase.milestones.some(one => one.code === 'comment-period'));
  assert.deepStrictEqual([holder.name, holder.milestones.at(-1).endDate], ['Pre-EA', '2005-02-28']);
});

test('a repeated register number is refused with a report entry', () => {
  const result = run({ projects: [register(), register()] });
  assert.deepStrictEqual(assessments(result), []);
  assert.strictEqual(reasons(result, 'duplicateKey').length, 2);
});

const suspension = { ref: ref('Suspensions', 1), id: 101, type: 'Suspension s.24(2)', appliedTo: 'Review', startDate: '2006-02-01', endDate: '2006-03-01' };
const eagleItem = (id, fields) => ({ id, type: 'Suspension', start: '2006-02-02', end: '2006-02-28', ...fields });
const linkedItem = (extensions) => run({ projects: [register({ start180: '2006-01-01' })], suspensions: [suspension] },
  { eagleItems: new Map([[PROJECT, { extensions, commentPeriods: [] }]]) });
const itemLink = (result) => assessments(result)[0].phases.flatMap(phase => phase.interruptions)[0].links.eagleItemId;

test('an interruption links to the Eagle item of its kind whose dates match within a day', () => {
  assert.strictEqual(itemLink(linkedItem([eagleItem('item-a'), eagleItem('item-b', { type: 'Extension' })])), 'item-a');
});

test('an Eagle item whose end date is more than a day off is not linked', () => {
  assert.strictEqual(itemLink(linkedItem([eagleItem('item-a', { end: '2006-03-05' })])), null);
});

test('two matching Eagle items link nothing and are listed', () => {
  const result = linkedItem([eagleItem('item-a'), eagleItem('item-b', { start: '2006-01-31' })]);
  assert.strictEqual(itemLink(result), null);
  assert.deepStrictEqual(reasons(result, 'eagleItemAmbiguous').map(entry => entry.candidates), [['item-a', 'item-b']]);
});

const pcp = { ref: ref('PCPs', 1), id: 101, type: 'Application PCP', startDate: '2005-02-01', endDate: '2005-02-28' };
const linkedPeriod = (commentPeriods) => {
  const result = run({ commentPeriods: [pcp] }, { eagleItems: new Map([[PROJECT, { extensions: [], commentPeriods }]]) });
  return { result, link: milestones(assessments(result)[0]).find(one => one.code === 'comment-period').links.commentPeriodId };
};

test('a comment period links only to an Eagle period whose read includes the public token', () => {
  const { link } = linkedPeriod([{ id: 'cp-staff', dateStarted: '2005-02-01', read: ['staff'] },
    { id: 'cp-public', dateStarted: '2005-02-04T08:00:00Z', read: ['staff', 'public'] }]);
  assert.strictEqual(link, 'cp-public');
});

test('an Eagle period starting more than three days off is not linked', () => {
  assert.strictEqual(linkedPeriod([{ id: 'cp-public', dateStarted: '2005-02-05', read: ['public'] }]).link, null);
});

test('two public Eagle periods in the window link nothing and are listed', () => {
  const { result, link } = linkedPeriod([{ id: 'cp-a', dateStarted: '2005-02-01', read: ['public'] },
    { id: 'cp-b', dateStarted: '2005-02-02', read: ['public'] }]);
  assert.strictEqual(link, null);
  assert.strictEqual(reasons(result, 'commentPeriodAmbiguous').length, 1);
});

const compared = (row, stored, options = {}) => run({ projects: [register(row)] }, { storedProjects: new Map([[PROJECT, stored]]), ...options });
const COMPARED_REASONS = ['expiryDiffers', 'substantialStartDateDiffers', 'ceaaDiffers', 'substantialStartDiffers'];
const comparedEntries = (result) => result.report.filter(entry => COMPARED_REASONS.includes(entry.reason))
  .map(({ reason, sheetField, field, projectId }) => ({ reason, sheetField, field, projectId }));

test('register fields that differ from the stored project are listed by field name only', () => {
  const result = compared({ expiryDate: '2013-05-01', substantialStartDate: '2012-01-01', ceaa: 'Yes' },
    { eacExpires: '2014-05-01', substantiallyDate: null, CEAAInvolvement: 'No' });
  assert.deepStrictEqual(comparedEntries(result), [
    { reason: 'expiryDiffers', sheetField: 'expiryDate', field: 'eacExpires', projectId: PROJECT },
    { reason: 'substantialStartDateDiffers', sheetField: 'substantialStartDate', field: 'substantiallyDate', projectId: PROJECT },
    { reason: 'ceaaDiffers', sheetField: 'ceaa', field: 'CEAAInvolvement', projectId: PROJECT }
  ]);
});

test('a stored timestamp on the same Pacific day and text differing only in case are not listed', () => {
  const result = compared({ expiryDate: '2013-05-01', ceaa: 'Comprehensive  Study' },
    { eacExpires: '2013-05-02T06:00:00Z', CEAAInvolvement: 'comprehensive study' });
  assert.deepStrictEqual(comparedEntries(result), []);
});

test('the sheet\'s substantial start is compared with the stored flag once the caller says how to read it', () => {
  const result = compared({ substantialStartDate: '2012-01-01' }, { substantially: false, substantiallyDate: '2012-01-01' },
    { substantialStart: () => true });
  assert.deepStrictEqual(comparedEntries(result).map(entry => entry.reason), ['substantialStartDiffers']);
});

const EVENT_SOURCES = ['amendments', 'suspensions', 'extensions', 'orderVariations', 'commentPeriods'];

test('the real workbook folder maps or reports every event row', { skip: !process.env.WORKS_REAL_DIR }, async () => {
  const { readFolder } = require('../../scripts/works-import/cells');
  const data = await readFolder(process.env.WORKS_REAL_DIR);
  const numbers = [...new Set(data.records.projects.map(row => row.id))];
  const result = mapBusinessWorks(data, {
    catalog: CATALOG, phaseCatalog: PHASES, crosswalk: new Map(numbers.map(n => [n, `project-${n}`])),
    batchId: 'batch-real', batchAt: '2026-11-13T18:00:00Z'
  });
  const keyOf = (at) => `${at.sheet}|${at.row}|${at.slot}`;
  const children = (one) => one.phases.flatMap(phase => [...phase.milestones, ...phase.interruptions]).filter(child => child.sourceRef);
  const seen = new Set([...result.report.filter(entry => entry.ref).map(entry => keyOf(entry.ref)),
    ...result.works.flatMap(one => [one.sourceRef.sheet, ...children(one).map(child => child.sourceRef.sheet)]).map(keyOf)]);
  assert.deepStrictEqual(EVENT_SOURCES.map(source => data.records[source].length), [329, 77, 86, 157, 386]);
  assert.strictEqual(EVENT_SOURCES.flatMap(source => data.records[source].filter(row => !seen.has(keyOf(row.ref)))).length, 0);
});
