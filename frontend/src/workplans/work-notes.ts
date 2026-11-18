import type { WorkplanRow } from '../api/sheet-works';
import type { WorkRow } from './derive';

/** Sheet works only: their phases, milestones and comment periods come from `/projects/:id/sheet-works`. */
export const hasDetails = (row: WorkRow): boolean => row.work.source === 'sheet';

export const projectDetailsPath = (projectId: string) => `/project-details/${encodeURIComponent(projectId)}`;

const SHEET_STATE_NOTE = new Map([
  ['completed', 'Completed'],
  ['inactive', 'Inactive'],
  ['withdrawn', 'Withdrawn'],
  ['terminated', 'Terminated'],
]);

/** How a closed work ended: its outcome with the certificate kind, else a sheet work's state; null when neither says. */
export function closedNoteOf(work: WorkplanRow): string | null {
  if (work.outcome) return work.certificateKind ? `${work.outcome} (${work.certificateKind})` : work.outcome;
  if (work.source !== 'sheet') return null;
  if (work.workState === 'transitioned') {
    const toAct = work.transitionOut?.toActYear;
    return toAct ? `Moved to the ${toAct} Act` : 'Moved to another Act';
  }
  return SHEET_STATE_NOTE.get(work.workState ?? '') ?? null;
}
