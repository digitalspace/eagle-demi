import { assignedOk } from './assigned';
import type { WorkplanPhase, WorkplanRow } from '../api/sheet-works';
import { type ActYear, type PhaseDays, type RowState, type WorkKind, isInactiveWork, isOpenPhase, isOpenWork, kindOf, phaseDays, workDates, workEndOf, workStartOf } from './chart-facts';
import { humanState, outcomeText } from './chart-words';
import { count, plural } from './format';
import type { ContextSpan } from './overview-assess';
import { DAY_MS, dayOf, daysBetween, endsBeforeStart } from './phase-bounds';

/** One project with every work it has, under any Act. */
export interface OverviewProject {
  projectId: string;
  projectName: string;
  works: WorkplanRow[];
}

/** Groups the `/workplans` body by project, keeping its order. */
export function projectsOf(works: readonly WorkplanRow[]): OverviewProject[] {
  const byId = new Map<string, OverviewProject>();
  for (const work of works) {
    const id = String(work.projectId);
    const project = byId.get(id) ?? { projectId: id, projectName: work.projectName ?? '', works: [] };
    project.works.push(work);
    byId.set(id, project);
  }
  return [...byId.values()];
}

/** Row text and the facts the filters, sort and chips read. */
export interface RowFacts {
  /** Line 2, in bold: the work type of the work line 2 describes. */
  l2w: string;
  /** Line 2 after the work type: where the work in progress is now, else the last decision. */
  l2: string;
  /** Red tag: "N days over limit" or "N days over plan". */
  tail: string;
  tailCls: '' | 'err';
  /** Phase of the work in progress that line 2 names. */
  phase: string | null;
  /** Days of the phase furthest over a legislated limit. */
  over: number;
  nOver: number;
  /** Next planned decision of a work in progress, else its last one. */
  next: string | null;
  /** Other works in progress besides the one line 2 names. */
  more: number;
  /** Phases that end before they start. */
  faults: number;
  open: boolean;
  /** Everything line 2 and the badge say, for the row's accessible name. */
  full: string;
}

interface Over {
  phase: WorkplanPhase;
  days: PhaseDays;
}

const ranOverText = ({ phase, days }: Over) =>
  `${phase.name} ran over its time limit by ${plural(days.over, 'day')} (${count(days.counted)} days counted, time limit ${count(days.limit ?? 0)})`;

/** Tag text, digits without grouping as in "Day N of". */
const daysOver = (n: number, what: 'limit' | 'plan') => `${n} ${n === 1 ? 'day' : 'days'} over ${what}`;

const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const byStart = (a: WorkplanPhase, b: WorkplanPhase) => ((dayOf(a.startDate) ?? '') < (dayOf(b.startDate) ?? '') ? -1 : 1);

function oversOf(works: readonly WorkplanRow[], today: string) {
  const overs: Over[] = [];
  let faults = 0;
  for (const work of works) {
    for (const phase of work.phases) {
      const days = phaseDays(phase, work, today);
      if (days && days.legal && days.over > 0) overs.push({ phase, days });
      if (endsBeforeStart(phase)) faults += 1;
    }
  }
  overs.sort((a, b) => b.days.over - a.days.over);
  return { overs, faults };
}

/** The phase a work in progress is in: its latest started open phase, else its latest started one. */
function currentOf(work: WorkplanRow, today: string) {
  const started = work.phases.filter((p) => { const start = dayOf(p.startDate); return start && start <= today; });
  const phase = started.filter(isOpenPhase).sort(byStart).pop() ?? started.sort(byStart).pop();
  const days = phase ? phaseDays(phase, work, today) : null;
  return { work, phase, days, late: days?.over ?? 0 };
}

/** Line 2 of a row with work in progress; true when its tag is "over plan". */
function openFacts(R: RowFacts, said: string[], openWorks: WorkplanRow[], today: string) {
  const cands = openWorks
    .map((work) => currentOf(work, today))
    .sort((a, b) => b.late - a.late || Number(isInactiveWork(a.work)) - Number(isInactiveWork(b.work)));
  const { work, phase, days } = cands[0];
  const type = work.workType ?? '';
  R.more = cands.length - 1;
  R.l2w = type;
  if (!phase) {
    const start = workStartOf(work);
    R.l2 = `${cap(humanState(work.workState))} since ${start ?? 'no recorded date'}`;
    said.push(`${type} ${humanState(work.workState)} since ${start ?? 'no recorded date'}`);
  } else {
    R.phase = phase.name;
    const start = dayOf(phase.startDate);
    if (isInactiveWork(work)) {
      R.l2 = `${phase.name}, inactive in Track`;
      said.push(`${type}, ${phase.name}, inactive in Track`);
    } else if (/suspended/i.test(work.workState ?? '')) {
      R.l2 = `Suspended since ${start}`;
      said.push(`${type} suspended since ${start}, in phase ${phase.name}`);
    } else if (days?.legal) {
      R.l2 = `Day ${days.counted} of ${phase.name}`;
      said.push(`${type}, ${phase.name}, ${count(days.counted)} days counted, time limit ${count(days.limit ?? 0)}`);
      if (days.over) {
        R.tail = daysOver(days.over, 'limit');
        R.tailCls = 'err';
        said.push(`${phase.name} is ${plural(days.over, 'day')} over its time limit`);
      }
    } else if (days) {
      R.l2 = `Day ${days.length} of ${phase.name}`;
      // A non-legislated phase has a planned length, not a time limit: it is said, never tagged as an overage.
      if (days.limit !== null) R.l2 += `, planned ${plural(days.limit, 'day')}`;
      said.push(`${type}, ${phase.name}, day ${days.length}${days.limit !== null ? `, planned ${plural(days.limit, 'day')}` : ''}`);
    } else {
      R.l2 = `${phase.name} since ${start}`;
      said.push(`${type}, ${phase.name}, from ${start}`);
    }
  }
  const planned = openWorks.filter((w) => !w.decisionDate && w.decisionEventDate).flatMap((w) => dayOf(w.decisionEventDate) ?? []).sort();
  R.next = planned.length ? planned.find((day) => day >= today) || planned[planned.length - 1] : null;
}

const movedText = (moved: NonNullable<WorkplanRow['transitionOut']>) =>
  `Moved to ${moved.toActYear ? `the ${moved.toActYear} Act` : 'another Act'} ${dayOf(moved.date) ?? '(no recorded date)'}`;

const decidedText = (work: WorkplanRow) => `${outcomeText(work) ?? ''} ${dayOf(work.decisionDate) ?? '(no recorded date)'}`;

/** Line 2 of a finished row: the last decision, else the last move or state, with the work type left to `l2w`. */
function closedFacts(R: RowFacts, works: readonly WorkplanRow[]) {
  const endOf = (work: WorkplanRow) => workEndOf(work) ?? '';
  const decided = works.filter((work) => work.outcome && work.decisionDate);
  const last = (decided.length ? decided : works).slice().sort((a, b) => (endOf(a) < endOf(b) ? -1 : 1)).pop() as WorkplanRow;
  const type = last.workType ?? '';
  R.l2w = type;
  if (last.transitionOut) R.l2 = movedText(last.transitionOut);
  else if (last.outcome) {
    const text = decidedText(last);
    // "Amendment approved" under an Amendment reads "Approved"; "EAC/Order Transfer is Granted" reads "Granted".
    const rest = type && text.toLowerCase().startsWith(`${type.toLowerCase()} `) ? text.slice(type.length + 1).replace(/^is\s+/i, '') : text;
    R.l2 = cap(rest);
  } else R.l2 = `${cap(humanState(last.workState))}${endOf(last) ? ` ${endOf(last)}` : ''}`;
}

/** Row facts of one project's works under one Act; `works` is never empty. */
export function rowFacts(works: readonly WorkplanRow[], today: string): RowFacts {
  const openWorks = works.filter(isOpenWork);
  const { overs, faults } = oversOf(works, today);
  const R: RowFacts = {
    l2w: '', l2: '', tail: '', tailCls: '', phase: null, over: overs.length ? overs[0].days.over : 0, nOver: overs.length,
    next: null, more: 0, faults, open: openWorks.length > 0, full: '',
  };
  const said: string[] = [];
  const ranOver = () => {
    R.tail = daysOver(overs[0].days.over, 'limit');
    R.tailCls = 'err';
    said.push(ranOverText(overs[0]));
  };
  if (openWorks.length) {
    openFacts(R, said, openWorks, today);
    if (!R.tail && overs.length) ranOver();
    if (R.more) said.push(`${plural(R.more, 'other work')} in progress`);
  } else {
    closedFacts(R, works);
    said.push(R.l2w ? `${R.l2w}: ${R.l2}` : R.l2);
    if (overs.length) ranOver();
  }
  if (R.nOver > 1) said.push(`${R.nOver} phases ran over a time limit`);
  R.full = said.join('. ');
  return R;
}

/** The assessment's own status under this Act, whatever the row's state; no assessment here names the Act that holds it. */
export function assessStatus(project: OverviewProject, year: ActYear, all: readonly WorkplanRow[]): string[] {
  const full = all.find((work) => work.workTypeCode === 'assessment');
  if (!full) {
    const other = project.works
      .filter((work) => work.workTypeCode === 'assessment' && work.actYear !== year)
      .sort((a, b) => (b.actYear ?? 0) - (a.actYear ?? 0))[0];
    return [other ? `Assessment under ${other.actYear} Act` : 'No assessment under any Act'];
  }
  const out: string[] = [];
  // Track works carry no transitionIn; the earlier Act's work says where it moved.
  const from = full.transitionIn
    ? full.transitionIn.fromActYear
    : project.works.find((w) => w.actYear !== year && w.transitionOut?.toActYear === year)?.actYear ?? null;
  if (from) out.push(`From ${from} Act`);
  if (full.transitionOut) out.push(movedText(full.transitionOut));
  else if (full.outcome) out.push(decidedText(full));
  else out.push(isOpenWork(full) ? 'Assessment in progress' : `Assessment ${humanState(full.workState)}`);
  return out;
}

/** One project under one Act, before the filters. */
export interface ActRow {
  project: OverviewProject;
  year: ActYear;
  /** The project's works under this Act. */
  all: WorkplanRow[];
  ctx: ContextSpan[];
  status: string[];
}

/** Rows of one Act; `axis` is that Act's axis (`start`, `end` days), null when it has none. */
export function actRows(projects: readonly OverviewProject[], year: ActYear, axis: { start: string; end: string } | null): ActRow[] {
  return projects.flatMap((project) => {
    const all = project.works.filter((work) => work.actYear === year);
    if (!all.length) return [];
    const ctx = project.works.flatMap((other): ContextSpan[] => {
      if (!axis || other.actYear === year || other.workTypeCode !== 'assessment') return [];
      const days = workDates(other);
      const s0 = days[0];
      const e0 = workEndOf(other) || days[days.length - 1];
      if (!s0 || !e0 || e0 < axis.start || s0 > axis.end) return [];
      return [{ s: s0 < axis.start ? axis.start : s0, e: e0 > axis.end ? axis.end : e0, s0, e0, w: other }];
    });
    return [{ project, year, all, ctx, status: assessStatus(project, year, all) }];
  });
}

export const WORK_KINDS: readonly [WorkKind, string][] = [
  ['assessment', 'Assessments'], ['amendment', 'Amendments'], ['eac-extension', 'Extensions'],
  ['substantial-start', 'Substantial starts'], ['other', 'Other'],
];

export const ROW_STATES: readonly [RowState, string][] = [['any', 'All'], ['open', 'In progress'], ['done', 'Finished']];

export type SortKey = 'start' | 'name' | 'phase' | 'over' | 'next' | 'decision' | 'length';
export const DEFAULT_SORT: SortKey = 'start';
export const SORTS: readonly [SortKey, string][] = [
  ['start', 'Start date'], ['name', 'Name'], ['phase', 'Current phase'], ['over', 'Days over time limit'],
  ['next', 'Next decision date'], ['decision', 'Decision date'], ['length', 'Longest assessment'],
];

/** A row that passed search and the work type toggles: the works it shows, their facts and sort keys. */
export interface Candidate {
  row: ActRow;
  name: string;
  works: WorkplanRow[];
  facts: RowFacts;
  keys: Record<SortKey, string | number>;
}

function sortKeys(name: string, works: readonly WorkplanRow[], facts: RowFacts, today: string): Candidate['keys'] {
  const first = works.find((work) => work.workTypeCode === 'assessment');
  const firstStart = first ? workStartOf(first) : null;
  const length = first && firstStart ? daysBetween(firstStart, workEndOf(first) || today) : null;
  const starts = works.flatMap((work) => workStartOf(work) ?? []).sort();
  return {
    start: starts[0] || '9999',
    name,
    decision: first ? dayOf(first.decisionDate) || dayOf(first.decisionEventDate) || '9999' : '9999',
    length: length === null ? 1 : -length,
    // Rows with no phase sort last.
    phase: facts.phase || '￿',
    over: facts.over ? -facts.over : 1,
    next: facts.next || '9999',
  };
}

/** A work's own name or type holds the search text. */
const workHas = (work: WorkplanRow, q: string) => `${work.title ?? ''} ${work.workType ?? ''}`.toLowerCase().includes(q);

/**
 * Search by project name or ID, or by work name, and the work type toggles; facts come from the works left.
 * A project that matches keeps all its works; one found only through a work keeps the works that match.
 */
export function candidatesOf(rows: readonly ActRow[], query: string, off: ReadonlySet<WorkKind>, today: string, who = '', team = ''): Candidate[] {
  const q = query.trim().toLowerCase();
  return rows.flatMap((row) => {
    const name = row.project.projectName;
    const whole = !q || name.toLowerCase().includes(q) || row.project.projectId.toLowerCase().includes(q);
    const works = row.all.filter((work) => (whole || workHas(work, q)) && !off.has(kindOf(work)) && assignedOk(work, who, team));
    if (!works.length) return [];
    const facts = rowFacts(works, today);
    return [{ row, name, works, facts, keys: sortKeys(name, works, facts, today) }];
  });
}

export interface RowFilters {
  state: RowState;
  /** Phase name, or '' for any. */
  phase: string;
  overOnly: boolean;
}

const stateOk = (c: Candidate, state: RowState) => state === 'any' || (state === 'open') === c.facts.open;
const phaseOk = (c: Candidate, f: RowFilters) => !f.phase || c.facts.phase === f.phase;
const overOk = (c: Candidate, f: RowFilters) => !f.overOnly || c.facts.over > 0;

export const passes = (c: Candidate, f: RowFilters) => stateOk(c, f.state) && phaseOk(c, f) && overOk(c, f);

export interface FilterCounts {
  /** Rows per State choice under the other filters. */
  states: Record<RowState, number>;
  /** Rows over a time limit under the State and phase filters. */
  over: number;
  /** Phase names for the phase select, sorted. */
  phases: string[];
}

/** Counts for each control over every Act's candidates, so a control shows what picking it would give. */
export function filterCounts(cands: readonly Candidate[], f: RowFilters): FilterCounts {
  const states: Record<RowState, number> = { any: 0, open: 0, done: 0 };
  const phases = new Set<string>();
  let over = 0;
  for (const c of cands) {
    if (c.facts.phase) phases.add(c.facts.phase);
    if (phaseOk(c, f) && overOk(c, f)) for (const [state] of ROW_STATES) if (stateOk(c, state)) states[state] += 1;
    if (stateOk(c, f.state) && phaseOk(c, f) && c.facts.over > 0) over += 1;
  }
  return { states, over, phases: [...phases].sort() };
}

const byName = (a: Candidate, b: Candidate) => a.name.localeCompare(b.name, 'en', { numeric: true });

/** A sorted copy; ties fall back to the name. */
export function sortRows(cands: readonly Candidate[], key: SortKey): Candidate[] {
  return cands.slice().sort((a, b) => {
    if (key === 'name') return byName(a, b);
    const x = a.keys[key];
    const y = b.keys[key];
    return x < y ? -1 : x > y ? 1 : byName(a, b);
  });
}

const MONTH_YEAR = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const MONTH_MS = (365.2425 * DAY_MS) / 12;

/** Months counted from year 0, so month arithmetic is plain addition. */
const monthOf = (ms: number) => new Date(ms).getUTCFullYear() * 12 + new Date(ms).getUTCMonth();
const monthStart = (month: number) => Date.UTC(Math.floor(month / 12), month % 12, 1);
const nearestMonth = (ms: number) => {
  const month = monthOf(ms);
  return ms - monthStart(month) < monthStart(month + 1) - ms ? month : month + 1;
};

/** Where an Act's timeline is scrolled: `left` and `right` are the visible edges as fractions of the axis, past 0 or 1 over its empty ends. */
export interface RangeView {
  zoomed: boolean;
  left: number;
  right: number;
}

/**
 * "Showing all dates, 1995 to 2026", or "Showing Jan 2010 to Dec 2014" while zoomed; `a0`, `a1` are the axis ends in epoch ms.
 * Starts at the month nearest the left edge and counts the view's width in whole months, so one year always names 12.
 */
export function rangeText(a0: number, a1: number, todayIn: boolean, view: RangeView): string {
  if (!view.zoomed) return `Showing all dates, ${new Date(a0).getUTCFullYear()} to ${new Date(a1).getUTCFullYear() - 1}`;
  const left = Math.max(0, view.left);
  const right = Math.min(1, view.right);
  if (!(right > left) || !(a1 > a0)) return '';
  const span = a1 - a0;
  const months = Math.max(1, Math.round(((right - left) * span) / MONTH_MS));
  const lastOfAxis = monthOf(a1 - DAY_MS);
  const first = Math.min(Math.max(monthOf(a0), nearestMonth(a0 + left * span)), lastOfAxis);
  const last = Math.min(lastOfAxis, first + months - 1);
  const from = MONTH_YEAR.format(monthStart(first));
  const to = MONTH_YEAR.format(monthStart(last));
  return `Showing ${from} to ${to}${!todayIn && view.right > 0.995 ? ', the last dates under this Act' : ''}`;
}
