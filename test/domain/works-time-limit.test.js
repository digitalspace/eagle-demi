'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { timeLimitsOf } = require('../../src/domain/works-time-limit');

const TODAY = '2026-11-27';
const SHEET_2002 = { source: 'sheet', actYear: 2002, workState: 'in-progress', isActive: true };
const TRACK = { source: 'track', actYear: 2018, workState: 'IN_PROGRESS', isActive: true };

const phase = (fields) => ({
  name: 'Referral', startDate: '2010-01-01', endDate: '2010-02-15', numberOfDays: 45, legislated: true, isCompleted: true,
  isCurrent: null, extensionDays: 0, suspendedDays: 0, interruptions: [], ...fields
});
// Track dates arrive as UTC timestamps of Pacific midnight.
const trackDay = (day) => `${day}T08:00:00.000Z`;
const trackPhase = (start, end, fields) => phase({ startDate: trackDay(start), endDate: trackDay(end), isCurrent: false, ...fields });

const limitsOf = (work, phases, today = TODAY) => timeLimitsOf(work, phases, today);
const lastLimit = (work, phases, today) => limitsOf(work, phases, today).at(-1);

test('a phase without a legislated day budget and a start has no time limit', () => {
  assert.deepStrictEqual(limitsOf(SHEET_2002, [phase({ legislated: false }), phase({ legislated: null }),
    phase({ numberOfDays: null }), phase({ startDate: null })]), [null, null, null, null]);
});

test('a sheet phase starting on the end of a legislated phase before it is Day One', () => {
  const before = phase({ name: 'Application Review', startDate: '2009-07-05', endDate: '2010-01-01', numberOfDays: 180 });
  assert.strictEqual(lastLimit(SHEET_2002, [before, phase()]).dayCount, 'one');
});

test('a sheet phase starting the day after the phase before it is Day Zero', () => {
  const before = phase({ name: 'Application Review', startDate: '2009-07-05', endDate: '2009-12-31', numberOfDays: 180 });
  assert.strictEqual(lastLimit(SHEET_2002, [before, phase()]).dayCount, 'zero');
});

test('a Track phase starting the day after the end of a legislated phase before it is Day One', () => {
  const before = trackPhase('2024-01-01', '2024-03-31');
  assert.strictEqual(lastLimit(TRACK, [before, trackPhase('2024-04-01', '2024-05-16')]).dayCount, 'one');
});

test('a phase after one with no legislated budget is Day Zero', () => {
  const before = trackPhase('2024-01-01', '2024-03-31', { legislated: false });
  assert.strictEqual(lastLimit(TRACK, [before, trackPhase('2024-04-01', '2024-05-16')]).dayCount, 'zero');
});

test('the deadline adds the budget, extension and suspended days to the start, one less on Day One', () => {
  const fields = { numberOfDays: 45, extensionDays: 10, suspendedDays: 5, isCompleted: false };
  const open = trackPhase('2024-04-01', '2024-05-16', fields);
  assert.deepStrictEqual([lastLimit(TRACK, [open]), lastLimit(TRACK, [trackPhase('2024-01-01', '2024-03-31'), open])]
    .map(limit => [limit.allowedDays, limit.deadline]), [[55, '2024-05-31'], [55, '2024-05-30']]);
});

test('a finished phase counts its days to its end less suspended days, one more on Day One', () => {
  const finished = (fields) => trackPhase('2024-04-01', '2024-06-01', { suspendedDays: 7, ...fields });
  assert.deepStrictEqual([lastLimit(TRACK, [finished()]).countedDays,
    lastLimit(TRACK, [trackPhase('2024-01-01', '2024-03-31'), finished()]).countedDays], [54, 55]);
});

test('a running phase counts its days to today and is over by the days past its budget', () => {
  const running = trackPhase('2026-10-01', '2026-11-15', { isCompleted: false, isCurrent: true, extensionDays: 10 });
  assert.deepStrictEqual(lastLimit(TRACK, [running]), {
    dayCount: 'zero', allowedDays: 55, deadline: '2026-11-25', countedDays: 57, overDays: 2, endKnown: true, coveredByExtension: false
  });
});

test('an unfinished phase of a closed work counts no days', () => {
  const unfinished = trackPhase('2026-10-01', '2026-11-15', { isCompleted: false, isCurrent: true });
  assert.strictEqual(lastLimit({ ...TRACK, workState: 'TERMINATED' }, [unfinished]).countedDays, null);
});

test('a phase that has not started yet has counted no days', () => {
  const planned = trackPhase('2027-01-01', '2027-02-15', { isCompleted: false });
  assert.strictEqual(lastLimit(TRACK, [planned]).countedDays, 0);
});

// The import ends Evaluation on the Review start.
const EVALUATION = phase({ name: 'Evaluation', startDate: '2010-01-01', endDate: '2010-06-01', numberOfDays: 30 });
const REVIEW = phase({ name: 'Application Review', startDate: '2010-06-01', endDate: '2010-11-28', numberOfDays: 180 });

test('a 2002 sheet Evaluation with no Extra Time after it has an unknown end and no over count', () => {
  const [limit] = limitsOf(SHEET_2002, [EVALUATION, REVIEW]);
  assert.deepStrictEqual([limit.endKnown, limit.overDays, limit.coveredByExtension], [false, null, false]);
});

test('a 2002 sheet Evaluation followed by Extra Time has a known end', () => {
  const evaluation = phase({ name: 'Evaluation', startDate: '2010-01-01', endDate: '2010-02-15', numberOfDays: 30 });
  const extra = phase({ name: 'Extra Time', startDate: '2010-02-15', endDate: '2010-06-01', legislated: false });
  const [limit] = limitsOf(SHEET_2002, [evaluation, extra]);
  assert.deepStrictEqual([limit.endKnown, limit.overDays], [true, 15]);
});

test('an Application Review right after an Evaluation with an unknown end is Day Zero', () => {
  assert.strictEqual(lastLimit(SHEET_2002, [EVALUATION, REVIEW]).dayCount, 'zero');
});

test('a finished sheet phase past its budget with an extension is covered and keeps its overrun', () => {
  const extended = phase({ extensionDays: 5, interruptions: [{ kind: 'extension', days: 5 }], endDate: '2010-03-01' });
  const limit = lastLimit(SHEET_2002, [extended]);
  assert.deepStrictEqual([limit.countedDays, limit.allowedDays, limit.overDays, limit.coveredByExtension], [59, 50, 9, true]);
});

test('a finished Track phase past its budget with extension days is covered', () => {
  const limit = lastLimit(TRACK, [trackPhase('2024-04-01', '2024-06-01', { extensionDays: 3 })]);
  assert.deepStrictEqual([limit.overDays, limit.coveredByExtension], [13, true]);
});

test('a finished phase past its budget with no extension is over', () => {
  const limit = lastLimit(SHEET_2002, [phase({ endDate: '2010-03-01' })]);
  assert.deepStrictEqual([limit.overDays, limit.coveredByExtension], [14, false]);
});

const UNCOUNTED_EXTENSION = { extensionDays: null, interruptions: [{ kind: 'extension', days: null }] };

test('a running phase with an unknown extension day count has unknown allowed days, deadline and over count', () => {
  const running = phase({ ...UNCOUNTED_EXTENSION, startDate: '2026-10-01', endDate: null, isCompleted: false });
  const limit = lastLimit(SHEET_2002, [running]);
  assert.deepStrictEqual([limit.allowedDays, limit.deadline, limit.overDays, limit.countedDays], [null, null, null, 57]);
});

test('a finished phase with an extension of unknown day count is covered with an unknown overrun', () => {
  const limit = lastLimit(SHEET_2002, [phase(UNCOUNTED_EXTENSION)]);
  assert.deepStrictEqual([limit.allowedDays, limit.deadline, limit.overDays, limit.coveredByExtension], [null, null, null, true]);
});

test('an unknown suspended day count leaves the deadline, counted days and over count unknown', () => {
  const limit = lastLimit(SHEET_2002, [phase({ suspendedDays: null })]);
  assert.deepStrictEqual([limit.allowedDays, limit.deadline, limit.countedDays, limit.overDays], [45, null, null, null]);
});

test('a finished phase that ends before it starts counts no days and has no overrun', () => {
  const backwards = trackPhase('2026-01-16', '2026-01-06', { isCurrent: true });
  const limit = lastLimit(TRACK, [backwards]);
  assert.deepStrictEqual([limit.countedDays, limit.overDays, limit.deadline], [null, null, '2026-03-02']);
});

test('a finished phase that ends before it starts is not covered by an extension', () => {
  const limit = lastLimit(SHEET_2002, [phase({ ...UNCOUNTED_EXTENSION, endDate: '2009-12-20' })]);
  assert.strictEqual(limit.coveredByExtension, false);
});

const SUSPENDED_TRACK = { ...TRACK, workState: 'SUSPENDED' };
const heldPhase = (end, numberOfDays) => trackPhase('2026-01-01', end, { numberOfDays, isCompleted: false, isCurrent: true,
  isSuspended: true, suspendedDate: trackDay('2026-02-01') });

test('a running phase suspended now stops counting at the day its suspension began', () => {
  assert.strictEqual(lastLimit(SUSPENDED_TRACK, [heldPhase('2026-06-30', 180)]).countedDays, 31);
});

test('a running phase suspended after its budget ran out is not over while it is held', () => {
  assert.strictEqual(lastLimit(SUSPENDED_TRACK, [heldPhase('2026-01-21', 20)]).overDays, 0);
});

test('a running sheet phase stops counting at the start of a suspension covering today', () => {
  const stop = { kind: 'suspension', startDate: '2026-11-01', endDate: '2026-12-31', days: 60 };
  const held = phase({ startDate: '2026-10-01', endDate: null, isCompleted: false, suspendedDays: 60, interruptions: [stop] });
  assert.strictEqual(lastLimit(SHEET_2002, [held]).countedDays, 31);
});

test('a running phase of a Track work switched off counts no days', () => {
  const running = trackPhase('2026-10-01', '2026-11-15', { isCompleted: false, isCurrent: true });
  assert.strictEqual(lastLimit({ ...TRACK, isActive: false }, [running]).countedDays, null);
});

test('an unfinished Track phase while Track names another phase current counts no days', () => {
  const other = trackPhase('2026-01-01', '2026-03-01', { isCompleted: false, isCurrent: false });
  const current = trackPhase('2026-03-02', '2026-04-16', { isCompleted: false, isCurrent: true });
  assert.strictEqual(limitsOf(TRACK, [other, current])[0].countedDays, null);
});

test('a finished Track phase past its budget with no extension days is over, not covered', () => {
  const limit = lastLimit(TRACK, [trackPhase('2024-04-01', '2024-06-01', { extensionDays: 0 })]);
  assert.deepStrictEqual([limit.overDays, limit.coveredByExtension], [16, false]);
});
