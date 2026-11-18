import { useLayoutEffect, type RefObject } from 'react';
import type { WorkplanRow } from '../api/sheet-works';
import { dayMonthYear } from '../dates';
import type { WorkRow } from './derive';

/** Sheet works only: their phases, milestones and comment periods come from `/projects/:id/sheet-works`. */
export const hasDetails = (row: WorkRow): boolean => row.work.source === 'sheet';

/**
 * While `active`, calls `reveal` each time the panel changes size, so details coming in are scrolled into view.
 * Stops, and calls `onDone`, once nothing in the panel is busy, so later resizes leave the scroll alone.
 */
export function useFollowDetails(
  panel: RefObject<HTMLElement | null>,
  active: boolean,
  reveal: (panel: HTMLElement) => void,
  onDone: () => void,
) {
  useLayoutEffect(() => {
    const el = panel.current;
    if (!active || !el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      reveal(el);
      if (el.querySelector('[aria-busy="true"]')) return;
      observer.disconnect();
      onDone();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [panel, active, reveal, onDone]);
}

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
