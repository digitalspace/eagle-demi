import { dayMonthYear } from '../dates';
import type { WorkRow } from './derive';
import { dayNumber } from './timeline-scale';

export type GroupBy = 'act' | 'type' | 'region';

export const GROUP_BYS: { value: GroupBy; label: string }[] = [
  { value: 'act', label: 'Act' },
  { value: 'type', label: 'Work type' },
  { value: 'region', label: 'Region' },
];

/** Short code and full name per `workTypeCode`, in the order type groups appear. */
const WORK_TYPES: Record<string, { code: string; name: string }> = {
  assessment: { code: 'EA', name: 'Assessment' },
  amendment: { code: 'AMD', name: 'Amendment' },
  'substantial-start': { code: 'SS', name: 'Substantial start' },
  'eac-extension': { code: 'EXT', name: 'EAC extension' },
};
const TYPE_ORDER = Object.keys(WORK_TYPES);

export const workTypeOf = (row: WorkRow) =>
  WORK_TYPES[row.work.workTypeCode ?? ''] ?? { code: '—', name: row.work.workTypeCode ?? 'Work type not known' };

export interface Group {
  key: string;
  label: string;
  rows: WorkRow[];
  overdue: number;
}

/** `rank` orders groups; equal ranks fall back to the label. */
function keyOf(row: WorkRow, by: GroupBy): { key: string; label: string; rank: number } {
  if (by === 'act') {
    const year = row.work.actYear;
    return year ? { key: `act-${year}`, label: `${year} Act`, rank: -year } : { key: 'act-none', label: 'Act not known', rank: 0 };
  }
  if (by === 'type') {
    const index = TYPE_ORDER.indexOf(row.work.workTypeCode ?? '');
    return { key: `type-${row.work.workTypeCode}`, label: workTypeOf(row).name, rank: index < 0 ? TYPE_ORDER.length : index };
  }
  return row.region
    ? { key: `region-${row.region}`, label: row.region, rank: 0 }
    : { key: 'region-none', label: 'Region not known', rank: 1 };
}

const firstStart = (row: WorkRow) => (row.segments.length ? dayNumber(row.segments[0].start) : Infinity);

/** Rows in groups (newest Act first, type order, regions A to Z); each group by first phase start, undated last. */
export function groupsOf(rows: WorkRow[], by: GroupBy): Group[] {
  const groups = new Map<string, Group & { rank: number }>();
  for (const row of rows) {
    const { key, label, rank } = keyOf(row, by);
    const group = groups.get(key) ?? { key, label, rank, rows: [], overdue: 0 };
    group.rows.push(row);
    if (row.overdue) group.overdue += 1;
    groups.set(key, group);
  }
  const sorted = [...groups.values()].sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  for (const group of sorted) {
    group.rows.sort((a, b) => firstStart(a) - firstStart(b) || (a.work.title ?? '').localeCompare(b.work.title ?? ''));
  }
  return sorted.map(({ key, label, rows: groupRows, overdue }) => ({ key, label, rows: groupRows, overdue }));
}

/** The days-in-phase cell: "used/planned", "+Nd over", elapsed alone when nothing is planned. */
export function daysOf(row: WorkRow): string {
  if (row.closed) return 'Closed';
  if (row.notStarted) return 'Not started';
  if (row.overdue) return `+${row.daysOver}d over`;
  if (row.daysInPhase === null) return '—';
  return row.plannedDays ? `${row.daysInPhase}/${row.plannedDays}` : `${row.daysInPhase}d`;
}

const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;
const STATE_TEXT = { past: 'Done', current: 'Current', upcoming: 'Planned' } as const;

function progressText(row: WorkRow): string {
  if (row.closed) return 'Closed.';
  if (row.notStarted) return 'Not started.';
  const phase = row.current?.name || 'Current phase';
  if (row.overdue) return `${phase}, ${days(row.daysOver)} overdue.`;
  if (row.daysInPhase === null) return 'No current phase.';
  return row.plannedDays
    ? `${phase}, day ${row.daysInPhase} of ${row.plannedDays} planned.`
    : `${phase}, ${days(row.daysInPhase)} in phase.`;
}

/** What the bars show, for screen readers: progress, suspension, then each dated phase. */
export function summaryOf(row: WorkRow): string {
  const suspended = row.suspended ? ` Suspended${row.suspendedUnder ? ` under ${row.suspendedUnder}` : ''}.` : '';
  const phases = row.segments.length
    ? row.segments
        .map((s) => `${STATE_TEXT[s.state]}: ${s.name || 'Unnamed phase'}, ${dayMonthYear(s.start)} to ${dayMonthYear(s.end)}`)
        .join('; ')
    : 'No dated phases';
  return `${progressText(row)}${suspended} ${phases}.`;
}
