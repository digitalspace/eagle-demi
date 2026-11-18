import type { WorkplanRow } from '../api/sheet-works';
import { dayMonthYear } from '../dates';
import type { WorkRow } from './derive';

/** Sheet works only: their phases, milestones and comment periods come from `/projects/:id/sheet-works`. */
export const hasDetails = (row: WorkRow): boolean => row.work.source === 'sheet';

export const projectDetailsPath = (projectId: string) => `/project-details/${encodeURIComponent(projectId)}`;

/** "Moved to the 2002 Act on 1 Jun 2003", or "Moved from …"; the day only when known. */
export function movedText(way: 'to' | 'from', actYear: number | null | undefined, date?: string | null): string {
  const act = actYear ? `the ${actYear} Act` : way === 'to' ? 'another Act' : 'an earlier Act';
  const day = dayMonthYear(date);
  return `Moved ${way} ${act}${day ? ` on ${day}` : ''}`;
}

const SHEET_STATE_NOTE = new Map([
  ['completed', 'Completed'],
  ['inactive', 'Inactive'],
  ['withdrawn', 'Withdrawn'],
  ['terminated', 'Terminated'],
]);

const TRACK_STATE_NOTE = new Map([
  ['WITHDRAWN', 'Withdrawn'],
  ['TERMINATED', 'Terminated'],
]);

/** How a closed work ended: its outcome with the certificate kind, else what its state says; null when neither says. */
export function closedNoteOf(work: WorkplanRow): string | null {
  if (work.outcome) return work.certificateKind ? `${work.outcome} (${work.certificateKind})` : work.outcome;
  if (work.source !== 'sheet') return TRACK_STATE_NOTE.get(work.workState ?? '') ?? null;
  if (work.workState === 'transitioned') return movedText('to', work.transitionOut?.toActYear);
  return SHEET_STATE_NOTE.get(work.workState ?? '') ?? null;
}
