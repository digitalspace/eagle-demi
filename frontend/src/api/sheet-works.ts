import { useQuery } from '@tanstack/react-query';
import { READ_TIMEOUT_MS, api } from './client';

/** A date the source left out, with the latest day it can be. Keyed by the date field it stands in for. */
export type Undated = Record<string, { notAfter: string | null }> | null;

interface SheetInterruption {
  kind: string | null;
  startDate: string | null;
  endDate: string | null;
  days: number | null;
  legalSection: string | null;
}

export interface SheetPhase {
  name: string | null;
  startDate: string | null;
  endDate: string | null;
  numberOfDays: number | null;
  order: number | null;
  undated: Undated;
  interruptions: SheetInterruption[];
}

export interface SheetMilestone {
  name: string | null;
  actualDate: string | null;
  anticipatedDate: string | null;
  endDate: string | null;
  outcome: string | null;
  numberOfDays: number | null;
  undated: Undated;
}

export interface SheetWork {
  workId: string;
  workType: string | null;
  title: string | null;
  actYear: number | null;
  startDate: string | null;
  decisionDate: string | null;
  anticipatedDecisionDate: string | null;
  outcome: string | null;
  transitionOut: { toActYear: number | null; date: string | null } | null;
  undated: Undated;
  phases: SheetPhase[];
  milestones: SheetMilestone[];
  /** Still on the public read once it reads Track and sheet works together. */
  shownAfterFlip: boolean;
  /** Shown only while Track has no work of its own for this one. */
  untilTrack: boolean;
  replaces: { title: string | null }[];
}

/** Never undefined: a `{}` body, which the e2e smoke sends for any path without a fixture, reads as no works. */
async function fetchSheetWorks(projectId: string, signal: AbortSignal): Promise<SheetWork[]> {
  const body = await api<{ works?: SheetWork[] } | null>(
    `/projects/${encodeURIComponent(projectId)}/sheet-works`,
    { signal, timeoutMs: READ_TIMEOUT_MS },
  );
  return Array.isArray(body?.works) ? body.works : [];
}

/** Business spreadsheet works stored for one project, test environments only. */
export function useSheetWorks(projectId: string) {
  return useQuery({
    queryKey: ['sheet-works', projectId],
    queryFn: ({ signal }) => fetchSheetWorks(projectId, signal),
    enabled: !!projectId,
    staleTime: 5 * 60_000,
  });
}
