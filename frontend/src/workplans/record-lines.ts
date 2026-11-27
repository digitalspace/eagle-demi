import type { RecordMark, RecordRow } from './record-types';

/** Single-date markers on a row: decisions, milestones, other events, a passed milestone. */
const MARKER = /^mk (dflag|dia|ring|msdue)\b/;
/** Line step in px, as on the Timeline. */
export const LINE_STEP = 16;
/** Half the drawn width of each marker, in px: decision circles 12 px, the rest at most 14 px. */
const half = (m: RecordMark) => (/\bdflag\b/.test(m.cls) ? 6 : 7);

/**
 * As on the Timeline: markers by date onto the first line where they keep 0.5 px clear of the one before; each extra
 * line moves the row's bars and strips down 16 px and makes the row that much taller. `px` turns percent into pixels.
 */
export function lineEvents(row: Pick<RecordRow, 'marks' | 'rowStyle'>, px: (pct: number) => number): number {
  const lines: { x: number; r: number }[] = [];
  const markers = row.marks.filter((m) => MARKER.test(m.cls)).sort((a, b) => a.left - b.left);
  for (const m of markers) {
    const x = px(m.left);
    const r = half(m);
    let line = lines.findIndex((l) => x - l.x >= l.r + r + 0.5);
    if (line < 0) line = lines.push({ x, r }) - 1;
    else lines[line] = { x, r };
    m.style = { ...m.style, '--evline': line };
  }
  const shift = Math.max(0, lines.length - 1) * LINE_STEP;
  if (shift) {
    const was = parseFloat(String(row.rowStyle.minHeight ?? '')) || 52;
    row.rowStyle = { ...row.rowStyle, '--evshift': `${shift}px`, minHeight: `${was + shift}px` };
  }
  return lines.length;
}
