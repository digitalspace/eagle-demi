import { describe, expect, it } from 'vitest';
import type { WorkplanRow } from '../api/sheet-works';
import fixture from '../../parity/fixtures/workplans.json';
import { rowsOf } from './derive';
import { daysOf, groupsOf } from './timeline-rows';
import { dayNumber, drawsSuspension, extentOf, scaleFor, scrollFor, spansOf, tagDayOf, ticksFor, xOf } from './timeline-scale';

const TODAY = '2026-11-17';
const VIEWPORT = 1000;
const rows = rowsOf(fixture.works as WorkplanRow[], [], TODAY);
const extent = extentOf(rows, TODAY);

describe('timeline scale', () => {
  it('Fit all spans the earliest phase start to the latest phase end', () => {
    const scale = scaleFor(extent, 'fit', TODAY, VIEWPORT);

    expect(scale.start).toBe(dayNumber('1997-02-01'));
    expect(scale.end).toBe(dayNumber('2028-02-01'));
    expect(scale.width).toBe(VIEWPORT);
  });

  it('Year zoom scrolls today into the viewport', () => {
    const scale = scaleFor(extent, 'year', TODAY, VIEWPORT);
    const todayInView = xOf(scale, dayNumber(TODAY)) - scrollFor(scale, dayNumber(TODAY), VIEWPORT);

    expect(scale.width).toBeGreaterThan(VIEWPORT);
    expect(todayInView).toBeGreaterThan(0);
    expect(todayInView).toBeLessThan(VIEWPORT);
  });

  it('a cell cut short at the axis edge drops its label, a full cell keeps it', () => {
    const { bottom } = ticksFor(scaleFor(extent, 'fit', TODAY, 240));

    expect(bottom[0]).toMatchObject({ label: '' });
    expect(bottom[1]).toMatchObject({ label: '2000' });
  });
});

describe('suspension', () => {
  const suspended = rows.find((row) => row.suspended)!;

  it('only a dated interruption draws a hatched span, which the legend keys', () => {
    expect(drawsSuspension([suspended], TODAY)).toBe(false);
    expect(drawsSuspension(rows, TODAY)).toBe(true);
  });

  it('the suspended tag starts after the current phase, clear of its label', () => {
    const spans = spansOf(suspended, TODAY);
    const current = spans.find((span) => span.kind === 'current')!;

    expect(tagDayOf(spans, TODAY)).toBe(dayNumber(current.end));
  });
});

describe('timeline rows', () => {
  const byTitle = (title: string) => rows.find((row) => row.work.title === title)!;

  it('days column reads overrun, used of planned, not started and closed', () => {
    expect(daysOf(byTitle('Sample Alpha Transmission Line - Assessment'))).toBe('+47d over');
    expect(daysOf(byTitle('Sample Beta Quarry - Amendment'))).toBe('47/182');
    expect(daysOf(byTitle('sample gamma wind farm - Assessment'))).toBe('Not started');
    expect(daysOf(byTitle('Sample Delta Pipeline - EAC Extension'))).toBe('Closed');
  });

  it('groups by Act, newest first, with each group\'s overdue count', () => {
    const groups = groupsOf(rows, 'act');

    expect(groups.map((g) => [g.label, g.rows.length, g.overdue])).toEqual([
      ['2018 Act', 5, 1],
      ['2002 Act', 7, 0],
      ['1996 Act', 2, 0],
    ]);
  });
});
