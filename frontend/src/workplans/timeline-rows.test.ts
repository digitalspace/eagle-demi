import { describe, expect, it } from 'vitest';
import fixture from '../../parity/fixtures/workplans.json';
import type { WorkplanRow } from '../api/sheet-works';
import { byAttention, rowsOf } from './derive';
import { daysOf, groupsOf, railOf, summaryOf } from './timeline-rows';
import { dayNumber } from './timeline-scale';

const TODAY = '2026-11-17';
const rows = rowsOf(fixture.works as WorkplanRow[], [], TODAY);
const titles = (group: { rows: typeof rows }) => group.rows.map((row) => row.work.title);

describe('timeline rows', () => {
  const byTitle = (title: string) => rows.find((row) => row.work.title === title)!;

  it('days column reads overrun, used of planned, suspended, not started and closed', () => {
    expect(daysOf(byTitle('Sample Alpha Transmission Line - Assessment'))).toBe('+47d over');
    expect(daysOf(byTitle('Sample Epsilon Terminal - Amendment'))).toBe('311 d, suspended');
    expect(daysOf(byTitle('Sample Beta Quarry - Amendment'))).toBe('47/182');
    expect(daysOf(byTitle('sample gamma wind farm - Assessment'))).toBe('Not started');
    expect(daysOf(byTitle('Sample Delta Pipeline - EAC Extension'))).toBe('Closed');
  });

  it('days column reads Inactive for a Track work switched off past its end', () => {
    const alpha = { ...byTitle('Sample Alpha Transmission Line - Assessment').work, isActive: false };

    expect(daysOf(rowsOf([alpha], [], TODAY)[0])).toBe('Inactive');
  });

  it('screen-reader summary names a started phase that is neither done nor current as not completed', () => {
    const alpha = structuredClone(byTitle('Sample Alpha Transmission Line - Assessment').work);
    alpha.phases[2] = { ...alpha.phases[2], startDate: '2026-10-02T08:00:00.000Z', isCurrent: true };

    expect(summaryOf(rowsOf([alpha], [], TODAY)[0], TODAY)).toContain('Not completed: Application Review,');
  });

  it('groups by Act, newest first, with each group\'s overdue count', () => {
    const groups = groupsOf(rows, 'act', TODAY);

    expect(groups.map((g) => [g.label, g.rows.length, g.overdue])).toEqual([
      ['2018 Act', 5, 1],
      ['2002 Act', 8, 0],
      ['1996 Act', 3, 0],
    ]);
  });

  it('sorts each group by attention when asked, by first phase start otherwise', () => {
    const byStart = groupsOf(rows, 'act', TODAY)[0];
    const attention = groupsOf(rows, 'act', TODAY, 'attention')[0];

    expect(titles(attention)).toEqual(titles({ rows: [...byStart.rows].sort(byAttention) }));
    expect(titles(attention)).not.toEqual(titles(byStart));
  });

  it('names a phase drawn from a latest-possible day as about that day', () => {
    expect(summaryOf(byTitle('Sample Alpha Transmission Line - Assessment (1996)'), TODAY)).toContain(
      'Pre-Application, about 1 Mar 2001 to',
    );
  });

  it('sorts by the first drawn bar, so a work with only approximate starts takes its place', () => {
    const act1996 = groupsOf(rows, 'act', TODAY).find((group) => group.key === 'act-1996')!;

    expect(titles(act1996)).toEqual([
      'sample gamma wind farm - Assessment (1996)',
      'Sample Delta Pipeline - Assessment (1996)',
      'Sample Alpha Transmission Line - Assessment (1996)',
    ]);
  });

  it('groups by project, A to Z, each project’s assessments first, then its other works by start', () => {
    const act2002 = rows.filter((row) => row.work.actYear === 2002);

    const groups = groupsOf(act2002, 'project', TODAY);

    expect(groups.map((group) => group.label)).toEqual([
      'Sample Alpha Transmission Line',
      'Sample Beta Quarry',
      'Sample Delta Pipeline',
      'Sample Epsilon Terminal',
      'sample gamma wind farm',
    ]);
    // By start alone the amendment (2004) would come first.
    expect(titles(groups[0])).toEqual([
      'Sample Alpha Transmission Line - Substation Assessment',
      'Sample Alpha Transmission Line - Assessment (2002)',
      'Sample Alpha Transmission Line - Amendment (2002)',
    ]);
  });

  it('runs a rail from the work’s own start to its decision when no phase can be drawn', () => {
    const gamma = byTitle('sample gamma wind farm - Assessment (1996)').work;
    const undrawn = { ...gamma, phases: gamma.phases.map((phase) => ({ ...phase, endDate: null })) };

    expect(railOf(rowsOf([undrawn], [], TODAY)[0], TODAY)).toEqual({
      start: dayNumber('1995-07-18'),
      end: dayNumber('1998-04-27'),
    });
  });
});
