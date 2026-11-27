import { describe, expect, it } from 'vitest';
import { lineEvents } from './record-lines';
import type { RecordMark } from './record-types';

const mk = (cls: string, left: number): RecordMark => ({ cls: `mk ${cls}`, style: {}, tip: { title: '', rows: [] } as unknown as RecordMark['tip'], id: '', left, backAt: null, label: '' });
const px = (pct: number) => pct * 10;

describe('lineEvents', () => {
  it('puts a marker that would touch the one before on the next line, and moves the bars down 16 px', () => {
    const marks = [mk('dia', 10), mk('ring', 10.5), mk('dflag go', 30), mk('bar', 5)];
    const row = { marks, rowStyle: {} };
    expect(lineEvents(row, px)).toBe(2);
    expect(marks.map((m) => m.style['--evline'])).toEqual([0, 1, 0, undefined]);
    expect(row.rowStyle).toEqual({ '--evshift': '16px', minHeight: '68px' });
  });

  it('leaves a row whose markers keep clear of each other on one line', () => {
    const row = { marks: [mk('dia', 10), mk('ring', 20)], rowStyle: {} };
    expect(lineEvents(row, px)).toBe(1);
    expect(row.rowStyle).toEqual({});
  });
});
