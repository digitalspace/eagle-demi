import { describe, expect, it } from 'vitest';
import type { WorkplanRow } from '../api/sheet-works';
import fixture from '../../parity/fixtures/workplans.json';
import { rowsOf } from './derive';
import {
  dayNumber,
  drawnKinds,
  extentOf,
  holdsDay,
  scaleFor,
  scrollFor,
  spansOf,
  tagDayOf,
  ticksFor,
  xOf,
} from './timeline-scale';

const TODAY = '2026-11-17';
const VIEWPORT = 1000;
const rows = rowsOf(fixture.works as WorkplanRow[], [], TODAY);
const extent = extentOf(rows, TODAY);

describe('timeline scale', () => {
  it('Fit all spans the earliest phase start to the latest phase end', () => {
    const scale = scaleFor(extent, 'fit', TODAY, VIEWPORT);

    expect(scale.start).toBe(dayNumber('1995-07-18'));
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

  it('Year zoom runs past the latest phase end', () => {
    const scale = scaleFor(extent, 'year', TODAY, VIEWPORT);

    expect(scale.end).toBeGreaterThanOrEqual(dayNumber('2028-02-01'));
  });

  const closed = extentOf(rows.filter((row) => row.work.actYear === 1996), TODAY);

  it('Fixed zoom stretches to today by default', () => {
    expect(holdsDay(scaleFor(closed, 'quarter', TODAY, VIEWPORT), dayNumber(TODAY))).toBe(true);
  });

  it('Fixed zoom leaves today off a group of closed works', () => {
    const scale = scaleFor(closed, 'quarter', TODAY, VIEWPORT, { includeToday: false });

    expect(holdsDay(scale, dayNumber(TODAY))).toBe(false);
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
    expect(drawnKinds([suspended], TODAY).has('suspended')).toBe(false);
    expect(drawnKinds(rows, TODAY).has('suspended')).toBe(true);
  });

  it('the suspended tag starts after the current phase, clear of its label', () => {
    const spans = spansOf(suspended, TODAY);
    const current = spans.find((span) => span.kind === 'current')!;

    expect(tagDayOf(spans, TODAY)).toBe(dayNumber(current.end));
  });

  it('an extension draws an extension band', () => {
    const work = structuredClone(suspended.work);
    work.phases[1].interruptions = [
      { kind: 'extension', startDate: '2026-03-01', endDate: '2026-04-01', days: 31, legalSection: null },
    ];

    const spans = spansOf(rowsOf([work], [], TODAY)[0], TODAY, { layers: 'all' });

    expect(spans.filter((span) => span.start === '2026-03-01')).toEqual([
      expect.objectContaining({ kind: 'extension', layer: 'overlay', end: '2026-04-01' }),
    ]);
  });
});

describe('span layers', () => {
  const sheet1996 = (title: string) =>
    rows.find((row) => row.work.source === 'sheet' && row.work.actYear === 1996 && row.work.title?.startsWith(title))!;

  it('a phase with an undated start spans from its notAfter day and is marked approximate', () => {
    const [preApplication] = spansOf(sheet1996('Sample Alpha'), TODAY);

    expect(preApplication).toMatchObject({
      name: 'Pre-Application',
      start: '2001-03-01',
      approx: { start: true, end: false },
    });
  });

  it('extentOf covers a decision marker past the last phase', () => {
    const work = { ...sheet1996('Sample Delta').work, decisionDate: '2000-03-01' };

    const marked = rowsOf([work], [], TODAY);

    expect(extentOf(marked, TODAY, { layers: 'all' })?.end).toBe(dayNumber('2000-03-01'));
    expect(spansOf(marked[0], TODAY, { layers: 'all' })).toContainEqual(
      expect.objectContaining({ kind: 'decision', layer: 'marker', start: '2000-03-01' }),
    );
  });
});
