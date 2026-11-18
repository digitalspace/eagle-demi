import type { WorkRow } from './derive';
import { dayNumber, type Extent } from './timeline-scale';

const DAY_MS = 86_400_000;

export interface QuarterCell {
  /** Day numbers, cut to the range asked for; `end` is exclusive. */
  start: number;
  end: number;
  label: string;
  /** Works with a dated phase or an overrun in this quarter. */
  count: number;
}

/** Days each dated phase and the overdue overrun cover; a gap between phases stays empty. */
const spansOf = (row: WorkRow): Extent[] => [
  ...row.segments.map((segment) => ({ start: dayNumber(segment.start), end: dayNumber(segment.end) })),
  ...(row.overrun ? [{ start: dayNumber(row.overrun.start), end: dayNumber(row.overrun.end) }] : []),
];

/** Calendar quarters across `range`, each with the number of works active in it. */
export function activeByQuarter(rows: WorkRow[], range: Extent): QuarterCell[] {
  const spans = rows.map(spansOf);
  const first = new Date(range.start * DAY_MS);
  let year = first.getUTCFullYear();
  let quarter = Math.floor(first.getUTCMonth() / 3);
  const cells: QuarterCell[] = [];
  for (let at = Date.UTC(year, quarter * 3, 1) / DAY_MS; at < range.end; ) {
    const label = `Q${quarter + 1} ${year}`;
    quarter = (quarter + 1) % 4;
    if (quarter === 0) year += 1;
    const next = Date.UTC(year, quarter * 3, 1) / DAY_MS;
    const start = Math.max(at, range.start);
    const end = Math.min(next, range.end);
    cells.push({ start, end, label, count: spans.filter((row) => row.some((span) => span.start < end && span.end >= start)).length });
    at = next;
  }
  return cells;
}
