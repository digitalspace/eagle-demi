import { dayMonthYear } from '../dates';
import { byAttention, STATUS_LABEL, type WorkRow } from './derive';
import { dayNumber } from './timeline-scale';
import { closedNoteOf } from './work-notes';
import { WORK_TYPE_ORDER, workTypeOf } from './work-types';

export type GroupBy = 'act' | 'type' | 'region';

export const GROUP_BYS: { value: GroupBy; label: string }[] = [
  { value: 'act', label: 'Act' },
  { value: 'type', label: 'Work type' },
  { value: 'region', label: 'Region' },
];

export type SortBy = 'start' | 'attention';

export const SORTS: { value: SortBy; label: string }[] = [
  { value: 'start', label: 'Start date' },
  { value: 'attention', label: 'Attention' },
];

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
    const index = WORK_TYPE_ORDER.indexOf(row.work.workTypeCode ?? '');
    return {
      key: `type-${row.work.workTypeCode}`,
      label: workTypeOf(row).name,
      rank: index < 0 ? WORK_TYPE_ORDER.length : index,
    };
  }
  return row.region
    ? { key: `region-${row.region}`, label: row.region, rank: 0 }
    : { key: 'region-none', label: 'Region not known', rank: 1 };
}

const firstStart = (row: WorkRow) => (row.segments.length ? dayNumber(row.segments[0].start) : Infinity);
const byStart = (a: WorkRow, b: WorkRow) =>
  firstStart(a) - firstStart(b) || (a.work.title ?? '').localeCompare(b.work.title ?? '');

/** Rows in groups (newest Act first, type order, regions A to Z); each by first phase start, undated last, or attention. */
export function groupsOf(rows: WorkRow[], by: GroupBy, sort: SortBy = 'start'): Group[] {
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
    group.rows.sort(sort === 'attention' ? byAttention : byStart);
  }
  return sorted.map(({ key, label, rows: groupRows, overdue }) => ({ key, label, rows: groupRows, overdue }));
}

/** Inactive and unknown works show their status in place of a day count, which would read as progress. */
export const unmeasuredStatus = (row: WorkRow) =>
  row.status === 'inactive' || row.status === 'unknown' ? STATUS_LABEL[row.status] : null;

/** Days a suspended phase ran before the suspension: "311 d, suspended"; `inPhase` names the unit where no header does. */
export const suspendedFigure = (days: number, inPhase = false) => `${days} d${inPhase ? ' in phase' : ''}, suspended`;

/** The days-in-phase cell: "used/planned", "+Nd over", "N d, suspended", elapsed alone when nothing is planned. */
export function daysOf(row: WorkRow): string {
  if (row.closed) return 'Closed';
  const status = unmeasuredStatus(row);
  if (status) return status;
  if (row.notStarted) return 'Not started';
  if (row.overdue) return `+${row.daysOver}d over`;
  if (row.daysInPhase === null) return '—';
  if (row.suspended) return suspendedFigure(row.daysInPhase);
  return row.plannedDays ? `${row.daysInPhase}/${row.plannedDays}` : `${row.daysInPhase}d`;
}

const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;
const STATE_TEXT = { past: 'Done', current: 'Current', incomplete: 'Not completed', upcoming: 'Planned' } as const;

/** "Closed. Certificate Issued (PAC), decision 3 Aug 2006." with whichever of the two is known. */
function closedText(row: WorkRow): string {
  const decided = dayMonthYear(row.work.decisionDate);
  const detail = [closedNoteOf(row.work), decided && `decision ${decided}`].filter(Boolean).join(', ');
  return detail ? `Closed. ${detail}.` : 'Closed.';
}

function progressText(row: WorkRow): string {
  if (row.closed) return closedText(row);
  const status = unmeasuredStatus(row);
  if (status) return `${status}.`;
  if (row.notStarted) return 'Not started.';
  const phase = row.current?.name || 'Current phase';
  if (row.overdue) return `${phase}, ${days(row.daysOver)} overdue.`;
  if (row.daysInPhase === null) return 'No current phase.';
  if (row.suspended) return `${phase}, ${days(row.daysInPhase)} in phase before the suspension.`;
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
