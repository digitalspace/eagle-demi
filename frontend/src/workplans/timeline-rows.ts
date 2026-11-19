import { dayMonthYear } from '../dates';
import { byAttention, STATUS_LABEL, type WorkRow } from './derive';
import { dayOf, drawnPhasesOf, startBound } from './phase-bounds';
import { dayNumber, extentOf, type Extent, type SpanKind, type Zoom } from './timeline-scale';
import { closedNoteOf } from './work-notes';
import { workStateOf } from './work-state';
import { WORK_TYPE_ORDER, workTypeOf } from './work-types';

/** `act` splits rows into the Act panels; the others group rows inside a panel. */
export type GroupBy = 'act' | 'project' | 'type' | 'region';

export const GROUP_BYS: { value: Exclude<GroupBy, 'act'>; label: string }[] = [
  { value: 'project', label: 'Project' },
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
  if (by === 'project') {
    const id = row.work.projectId;
    return { key: `project-${id}`, label: row.work.projectName || `Project ${id}`, rank: 0 };
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

/** First drawn bar's start, approximate bounds included, so the order matches the bars; undated last. */
const firstStart = (row: WorkRow, today: string) =>
  Math.min(...drawnPhasesOf(row, today).map((drawn) => dayNumber(drawn.start)));
const isAssessment = (row: WorkRow) => row.work.workTypeCode === 'assessment';

function rowOrder(by: GroupBy, sort: SortBy, today: string) {
  if (sort === 'attention') return byAttention;
  const starts = new Map<WorkRow, number>();
  const startOf = (row: WorkRow) => starts.get(row) ?? starts.set(row, firstStart(row, today)).get(row)!;
  const byStart = (a: WorkRow, b: WorkRow) =>
    startOf(a) - startOf(b) || (a.work.title ?? '').localeCompare(b.work.title ?? '');
  // A project reads as one process: its assessments, then the works under the certificate.
  return by === 'project' ? (a: WorkRow, b: WorkRow) => Number(isAssessment(b)) - Number(isAssessment(a)) || byStart(a, b) : byStart;
}

/**
 * Rows in groups (newest Act first, projects and regions A to Z, type order); each by first phase start, undated
 * last, a project's assessments first, or by attention.
 */
export function groupsOf(rows: WorkRow[], by: GroupBy, today: string, sort: SortBy = 'start'): Group[] {
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
    group.rows.sort(rowOrder(by, sort, today));
  }
  return sorted.map(({ key, label, rows: groupRows, overdue }) => ({ key, label, rows: groupRows, overdue }));
}

/** The days a row covers: every bar and marker, plus the work's own start and decision when they reach further. */
export function railOf(row: WorkRow, today: string): Extent | null {
  const drawn = extentOf([row], today, { layers: 'all' });
  const own = [startBound(row.work.startDate, row.work.undated), dayOf(row.decisionDate)].flatMap((day) =>
    day ? [dayNumber(day)] : [],
  );
  const days = [...own, ...(drawn ? [drawn.start, drawn.end] : [])];
  return days.length ? { start: Math.min(...days), end: Math.max(...days) } : null;
}

/** Union of the rows' rails; null when no row has a known day. */
export function spanOf(rows: WorkRow[], today: string): Extent | null {
  let span: Extent | null = null;
  for (const row of rows) {
    const rail = railOf(row, today);
    if (rail) span = span ? { start: Math.min(span.start, rail.start), end: Math.max(span.end, rail.end) } : rail;
  }
  return span;
}

/** Group key inside an Act panel, unique across panels. */
export const groupKeyOf = (actKey: string, key: string) => `${actKey}/${key}`;

/** The 2018 Act opens on today; older Acts fit each group's own span. */
export const defaultZoomOf = (act: Group): Zoom => ((act.rows[0]?.work.actYear ?? 0) >= 2018 ? 'quarter' : 'fit');

const yearOf = (day: number) => new Date(day * 86_400_000).getUTCFullYear();

/** "1995 to 2009", or one year. */
export function yearsOf(span: Extent): string {
  const [from, to] = [yearOf(span.start), yearOf(span.end)];
  return from === to ? String(from) : `${from} to ${to}`;
}

/** Kinds drawn as marks and bands, not bars; `decision` here is the decision day, not the Decision phase colour. */
export const MARK_KINDS: ReadonlySet<SpanKind> = new Set([
  'extension',
  'interregnum',
  'comment-period',
  'decision',
  'section-13',
  'transition-in',
  'transition-out',
]);

/** The bar or mark modifier class of a kind, shared by the rows and the legend. */
export const kindClassOf = (kind: SpanKind) => (MARK_KINDS.has(kind) ? `timeline__mark--${kind}` : `timeline__bar--${kind}`);

/** Only a group still running needs today on its axis; a closed group's axis ends at its last date. */
export const holdsOpenWork = (rows: WorkRow[]) => rows.some((row) => workStateOf(row) !== 'closed');

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

const about = (approx: boolean, day: string) => `${approx ? 'about ' : ''}${dayMonthYear(day)}`;

/** What the bars show, for screen readers: progress, suspension, then each drawn phase, approximate days as "about". */
export function summaryOf(row: WorkRow, today: string): string {
  const suspended = row.suspended ? ` Suspended${row.suspendedUnder ? ` under ${row.suspendedUnder}` : ''}.` : '';
  const drawn = drawnPhasesOf(row, today);
  const phases = drawn.length
    ? drawn
        .map(
          (d) =>
            `${STATE_TEXT[d.state]}: ${d.phase.name || 'Unnamed phase'}, ${about(d.approxStart, d.start)} to ${about(d.approxEnd, d.end)}`,
        )
        .join('; ')
    : 'No dated phases';
  return `${progressText(row)}${suspended} ${phases}.`;
}

/** Lane text for a row with no phase bar: what is known instead. */
export function undatedTextOf(row: WorkRow): string {
  const decided = dayMonthYear(row.decisionDate);
  if (!decided) return 'Phase dates not known.';
  return `${row.decisionExpected ? 'Decision expected' : 'Decision'} ${decided}. Phase dates not known.`;
}
