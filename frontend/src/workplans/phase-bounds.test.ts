import { describe, expect, it } from 'vitest';
import type { WorkplanPhase } from '../api/sheet-works';
import { drawnPhasesOf } from './phase-bounds';

const TODAY = '2026-11-17';

const phase = (name: string, extra: Partial<WorkplanPhase>): WorkplanPhase => ({
  name,
  stage: null,
  order: 1,
  startDate: null,
  endDate: null,
  numberOfDays: null,
  isCompleted: true,
  isSuspended: null,
  isCurrent: null,
  suspendedDate: null,
  extensionDays: null,
  suspendedDays: null,
  undated: null,
  interruptions: [],
  ...extra,
});

describe('drawnPhasesOf', () => {
  it('draws an undated start from its notAfter day, marked approximate', () => {
    // Project 145's 1996 assessment: Pre-EA has only a latest start and an end.
    const preEa = phase('Pre-EA', { order: 0, endDate: '1995-07-18', undated: { startDate: { notAfter: '1995-06-30' } } });
    const [drawn] = drawnPhasesOf({ phases: [preEa], current: null }, TODAY);
    expect(drawn).toMatchObject({ start: '1995-06-30', approxStart: true, end: '1995-07-18', approxEnd: false });
  });

  it('runs a current phase with no end to today, not approximate', () => {
    const review = phase('Application Review', { startDate: '2026-03-01', isCompleted: false });
    const [drawn] = drawnPhasesOf({ phases: [review], current: review }, TODAY);
    expect(drawn).toMatchObject({ state: 'current', end: TODAY, approxEnd: false });
  });

  it('ends a past phase with no end at the next phase’s start, marked approximate', () => {
    const intake = phase('Intake', { order: 0, startDate: '2004-01-05' });
    const review = phase('Review', { order: 1, startDate: '2004-06-01', endDate: '2005-01-10' });
    const [drawn] = drawnPhasesOf({ phases: [intake, review], current: null }, TODAY);
    expect(drawn).toMatchObject({ phase: intake, end: '2004-06-01', approxEnd: true });
  });

  it('treats an end before the start as missing', () => {
    const odd = phase('Evaluation', { order: 0, startDate: '2010-05-01', endDate: '2010-01-01' });
    const decision = phase('Decision', { order: 1, startDate: '2010-08-01', endDate: '2010-09-01' });
    const [drawn] = drawnPhasesOf({ phases: [odd, decision], current: null }, TODAY);
    expect(drawn).toMatchObject({ phase: odd, end: '2010-08-01', approxEnd: true });
  });
});
