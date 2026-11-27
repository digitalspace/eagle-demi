import type { WorkplanRow } from '../api/sheet-works';
import { ACT_START, phaseDays } from './chart-facts';
import { outcomeText } from './chart-words';
import { plural, count } from './format';
import { dayOf } from './phase-bounds';
import { dayNo, recordDays, recordStart, yearOf } from './record-axis';
import type { CertFact, NoteTone, RecordNote, Tag as RecordTag, TagTone } from './record-types';

export type { CertFact, NoteTone, RecordNote, RecordTag, TagTone };

/** One project and all its works; the same shape `projectsOf` in `overview-rows.ts` builds. */
export interface RecordProject {
  projectId: string;
  projectName: string;
  works: WorkplanRow[];
}

const isAssessment = (w: WorkplanRow) => w.workTypeCode === 'assessment';
const actOf = (w: WorkplanRow) => w.actYear ?? 0;
const byNumber = (x: number, y: number) => x - y;

/** The Acts a project has works under, oldest first. */
export const actsOf = (p: RecordProject) => [...new Set(p.works.map(actOf))].sort(byNumber);

/** "2002 Act", or "1996 and 2002 Acts". */
export function actsText(acts: readonly number[]): string {
  if (acts.length <= 1) return acts.length ? `${acts[0]} Act` : '';
  return `${acts.slice(0, -1).join(', ')} and ${acts[acts.length - 1]} Acts`;
}

/** The Act to open a project on: `keep` when it has works there, else its assessment's Act, else its first. */
export function actFor(p: RecordProject, keep: number | null): number {
  const acts = actsOf(p);
  if (keep != null && acts.includes(keep)) return keep;
  const assessment = p.works.find(isAssessment);
  return assessment ? actOf(assessment) : (acts[0] ?? actOf(p.works[0]));
}

export interface RecordPick {
  project: RecordProject;
  act: number;
}

/** Null for an unknown project id; a missing Act uses `actFor`, an Act the project lacks its first work's Act. */
export function pickRecord(projects: readonly RecordProject[], projectId: string, act: number | null): RecordPick | null {
  const project = projects.find((p) => p.projectId === projectId);
  if (!project || !project.works.length) return null;
  if (act == null) return { project, act: actFor(project, null) };
  return { project, act: project.works.some((w) => w.actYear === act) ? act : actOf(project.works[0]) };
}

export interface ComboOption {
  /** Element id, for `aria-activedescendant`. */
  id: string;
  projectId: string;
  label: string;
  sub: string;
  current: boolean;
}

/** An exact project number first, then numbers and names that start with the text, then the rest, each in list order. */
export function comboOptions(projects: readonly RecordProject[], query: string, currentId: string | null): ComboOption[] {
  const q = query.trim().toLowerCase();
  const rank = (p: RecordProject) => {
    const name = p.projectName.toLowerCase();
    if (p.projectId === q) return 0;
    if (p.projectId.startsWith(q)) return 1;
    return name.startsWith(q) ? 2 : 3;
  };
  const found = q
    ? projects
        .filter((p) => p.projectName.toLowerCase().includes(q) || p.projectId.includes(q))
        .map((p) => ({ p, r: rank(p) }))
        .sort((x, y) => x.r - y.r)
        .map((x) => x.p)
    : projects;
  return found.map((p) => {
    const current = p.projectId === currentId;
    const acts = actsText(actsOf(p));
    return {
      id: `rec-opt-${p.projectId}`,
      projectId: p.projectId,
      label: p.projectName,
      sub: `Project ${p.projectId}${acts ? `, ${acts}` : ''}${current ? ', open now' : ''}`,
      current,
    };
  });
}

export const noMatchText = (query: string) => `No project matches "${query.trim()}"`;

/** The active option after an arrow key, wrapping; 0 when there are no options. */
export const comboStep = (at: number, count: number, down: boolean) => (count ? (at + (down ? 1 : count - 1)) % count : 0);

/** The active option kept inside the list after it narrows. */
export const comboClamp = (at: number, count: number) => Math.min(Math.max(0, at), Math.max(0, count - 1));

/** An issued certificate: an assessment decided as "Certificate Issued" or "GRANTED". */
export const isCert = (w: WorkplanRow) =>
  isAssessment(w) && Boolean(w.decisionDate) && /Certificate Issued|GRANTED/i.test(w.outcome ?? '');

export interface RecordParts {
  assessment: WorkplanRow | null;
  /** The assessment under the Act the shown one moved to. */
  nextAssessment: WorkplanRow | null;
  /** Issued certificates, oldest first. */
  certs: CertFact[];
  /** The certificate the later works hang from: this Act's, or the project's first when this Act has no assessment. */
  cert: CertFact | null;
  /** Non-assessment works under `cert`, or under the shown Act when there is none, by start. */
  later: WorkplanRow[];
  /** The latest certificate issued on or before a work's start, else the first. */
  certFor: (w: WorkplanRow) => CertFact | null;
  /** Every Act the project has works under. */
  partActs: number[];
}

function certsOf(works: readonly WorkplanRow[]): CertFact[] {
  return works
    .flatMap((w) => {
      const day = isCert(w) ? dayNo(w.decisionDate) : null;
      return day == null ? [] : [{ work: w, day, act: actOf(w), kind: w.certificateKind || 'EAC' }];
    })
    .sort((x, y) => x.day - y.day);
}

export function recordParts(project: RecordProject, act: number, today: string): RecordParts {
  const { works } = project;
  const certs = certsOf(works);
  const certFor = (w: WorkplanRow) => {
    const start = recordStart(w, today);
    const before = start == null ? [] : certs.filter((c) => c.day <= start);
    return before.at(-1) ?? certs[0] ?? null;
  };
  const assessment = works.find((w) => w.actYear === act && isAssessment(w)) ?? null;
  const out = assessment?.transitionOut;
  const nextAssessment = out ? (works.find((w) => w.actYear === out.toActYear && isAssessment(w)) ?? null) : null;
  const ownCert = assessment && isCert(assessment) ? (certs.find((c) => c.work === assessment) ?? null) : null;
  const cert = assessment ? ownCert : (certs[0] ?? null);
  const startOf = (w: WorkplanRow) => recordStart(w, today) ?? 0;
  const later = works
    .filter((w) => !isAssessment(w))
    .filter((w) => (cert ? certFor(w) === cert : w.actYear === act))
    .sort((x, y) => startOf(x) - startOf(y));
  const partActs = [...new Set(works.map(actOf))].sort(byNumber);
  return { assessment, nextAssessment, certs, cert, later, certFor, partActs };
}

const STATE_TAGS: Record<string, RecordTag> = {
  completed: { text: 'Completed', tone: 'grey' },
  'in-progress': { text: 'In progress', tone: 'blue' },
  in_progress: { text: 'In progress', tone: 'blue' },
  suspended: { text: 'Suspended', tone: 'grey' },
  withdrawn: { text: 'Withdrawn', tone: 'grey' },
  terminated: { text: 'Terminated', tone: 'grey' },
  transitioned: { text: 'Moved to another Act', tone: 'grey' },
  inactive: { text: 'Inactive', tone: 'grey' },
  closed: { text: 'Closed', tone: 'grey' },
};

/** The outcome in plain words, green only when issued, granted or designated; else the state. */
export function stateTag(w: WorkplanRow): RecordTag {
  if (w.outcome) return { text: outcomeText(w) ?? '', tone: /Certificate Issued|Granted|Designates/i.test(w.outcome) ? 'green' : 'grey' };
  return STATE_TAGS[String(w.workState ?? '').toLowerCase()] ?? { text: w.workState ?? '', tone: 'grey' };
}

/** One step of the Act stepper. */
export interface PathStep {
  act: number;
  label: string;
  sub: string;
  current: boolean;
  /** Draws the connector from the step before. */
  hasConn: boolean;
}

function yearsOf(works: readonly WorkplanRow[]): string {
  const days = works.flatMap((w) => recordDays(w, null));
  return days.length ? `, ${yearOf(Math.min(...days))} to ${yearOf(Math.max(...days))}` : '';
}

export function recordPath(project: RecordProject, partActs: readonly number[], act: number): PathStep[] {
  return partActs.map((year, i) => {
    const under = project.works.filter((w) => actOf(w) === year);
    const hasAssessment = under.some(isAssessment);
    const others = under.length - (hasAssessment ? 1 : 0);
    const sub = [hasAssessment ? 'assessment' : '', others ? plural(others, 'later work') : ''].filter(Boolean).join(', ');
    return { act: year, label: `${year} Act`, sub: sub + yearsOf(under), current: year === act, hasConn: i > 0 };
  });
}

/** Extension and suspension days over every step of the assessment, summed by the caller. */
export interface LimitTotals {
  extended: number;
  suspended: number;
}

function startText(as: WorkplanRow): string | null {
  if (as.transitionIn) return `Continued from the ${as.transitionIn.fromActYear} Act on ${as.transitionIn.date}`;
  if (as.startDate) return `Started ${dayOf(as.startDate)}`;
  const notAfter = as.undated?.['startDate']?.notAfter;
  return notAfter ? `No recorded start date, not after ${notAfter}` : null;
}

/** The tag beside the name; none without an assessment under the Act. */
export function recordTag(as: WorkplanRow | null): RecordTag | null {
  if (!as) return null;
  return as.transitionOut ? { text: 'Moved', tone: 'grey' } : stateTag(as);
}

/** "Total Allotted Days per work": legislated limits added up, no extensions; projected = days taken plus days planned. */
// Force majeure suspensions would add to the total, but the data does not say which suspensions are force majeure.
export function allottedDays(as: WorkplanRow, today: string): { total: number; projected: number } | null {
  const legal = as.phases.filter((ph) => ph.legislated && ph.numberOfDays);
  if (!legal.length) return null;
  const total = legal.reduce((n, ph) => n + (ph.numberOfDays ?? 0), 0);
  const projected = legal.reduce((n, ph) => {
    const days = phaseDays(ph, as, today);
    const planned = ph.numberOfDays ?? 0;
    if (!days) return n + planned;
    return n + (days.current ? Math.max(days.counted, planned) : days.counted);
  }, 0);
  return { total, projected };
}

/**
 * The work's state in Track's words, then whether Track holds it active when it is still open: "In progress, active".
 * A finished work says only its state; a sheet work has no active flag of its own.
 */
export function workStateText(w: WorkplanRow): string {
  const state = STATE_TAGS[String(w.workState ?? '').toLowerCase()]?.text ?? w.workState ?? 'Not recorded';
  if (w.source !== 'track' || w.isActive == null || !/^in.progress$/i.test(w.workState ?? '')) return state;
  return `${state}, ${w.isActive ? 'active' : 'inactive'}`;
}

/** The header's key facts, label and value. */
export function recordFacts(project: RecordProject, act: number, as: WorkplanRow | null, totals: LimitTotals, today: string): { k: string; v: string; warn?: boolean }[] {
  const out: { k: string; v: string; warn?: boolean }[] = [
    { k: 'Project', v: project.projectId },
    { k: 'Act', v: `${act} Act` },
  ];
  if (!as) return [...out, { k: 'Assessment', v: 'none under this Act' }];
  out.push({ k: 'Work state', v: workStateText(as) });
  const start = startText(as);
  if (start) out.push({ k: /^Continued/.test(start) ? 'Continued' : 'Started', v: start.replace(/^(Started|Continued from the \d{4} Act on) /, '') });
  if (as.decisionDate) out.push({ k: 'Decision', v: dayOf(as.decisionDate) ?? '' });
  else if (as.transitionOut) out.push({ k: `Moved to the ${as.transitionOut.toActYear} Act`, v: `${as.transitionOut.date}, no decision under this Act` });
  else if (as.decisionEventDate) out.push({ k: 'Decision planned', v: dayOf(as.decisionEventDate) ?? '' });
  if (totals.extended) out.push({ k: 'Extended', v: plural(totals.extended, 'day') });
  if (totals.suspended) out.push({ k: 'Suspended', v: plural(totals.suspended, 'day') });
  const allotted = allottedDays(as, today);
  if (allotted) {
    out.push({ k: 'Total allotted days', v: plural(allotted.total, 'day') });
    const over = allotted.projected - allotted.total;
    out.push({ k: 'Projected', v: `${plural(allotted.projected, 'day')}${over > 0 ? `, ${count(over)} over` : ''}`, warn: over > 0 });
  }
  return out;
}

function assessmentNotes(as: WorkplanRow, act: number): string[] {
  const out: string[] = [];
  const notAfter = as.undated?.['startDate']?.notAfter;
  if (notAfter) out.push(`Assessment start: no recorded date, not after ${notAfter}`);
  const decided = dayOf(as.decisionDate);
  if (act === 1996 && !as.transitionOut && decided && decided >= ACT_START[2002]) {
    out.push(`Decided ${decided}, after the 2002 Act began; listed under the 1996 Act as recorded`);
  }
  if (act === 1996 && as.certificateKind === 'EAC') out.push('Certificate recorded as EAC on a 1996 assessment');
  return out;
}

function overlapNote(later: readonly WorkplanRow[]): string | null {
  const spans = later
    .filter((w) => w.workTypeCode === 'amendment' && w.startDate && w.decisionDate)
    .map((w) => ({ s: dayNo(w.startDate) ?? 0, e: dayNo(w.decisionDate) ?? 0 }))
    .sort((x, y) => x.s - y.s);
  let pairs = 0;
  spans.forEach((x, i) => {
    pairs += spans.slice(i + 1).filter((y) => y.s < x.e).length;
  });
  return pairs ? `${plural(pairs, 'pair')} of amendments overlap in time` : null;
}

/** The header's notes, all `info`; the caller adds them after the chart's own notes. */
export function headerNotes(parts: RecordParts, act: number): RecordNote[] {
  const texts = [
    ...(parts.assessment ? assessmentNotes(parts.assessment, act) : []),
    overlapNote(parts.later),
  ];
  return texts.flatMap((text) => (text ? [{ text, tone: 'info' as const }] : []));
}

/** Repeats dropped, then warnings and passes ahead of the rest, each in the order noted. */
export function noteList(notes: readonly RecordNote[]): RecordNote[] {
  const weight = (n: RecordNote) => (n.tone === 'info' ? 1 : 0);
  return notes.filter((n, i) => notes.findIndex((m) => m.text === n.text) === i).sort((x, y) => weight(x) - weight(y));
}
