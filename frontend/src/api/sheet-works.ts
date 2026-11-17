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
  legislated: boolean | null;
  order: number | null;
  stage: string | null;
  isCompleted: boolean;
  undated: Undated;
  interruptions: SheetInterruption[];
}

export interface SheetMilestone {
  name: string | null;
  code: string | null;
  eventType: string | null;
  actualDate: string | null;
  anticipatedDate: string | null;
  endDate: string | null;
  outcome: string | null;
  numberOfDays: number | null;
  links: { commentPeriodId: string | null };
  undated: Undated;
}

interface ReplacedTrackWork {
  workId: string;
  title: string | null;
  startDate: string | null;
  decisionDate: string | null;
}

export interface SheetWork {
  workId: string;
  source: string;
  workTypeCode: string | null;
  workType: string | null;
  title: string | null;
  eaAct: string | null;
  actYear: number | null;
  startDate: string | null;
  isActive: boolean | null;
  workState: string | null;
  decisionDate: string | null;
  anticipatedDecisionDate: string | null;
  outcome: string | null;
  transitionOut: { toActYear: number | null; date: string | null; dateSource: string } | null;
  undated: Undated;
  phases: SheetPhase[];
  milestones: SheetMilestone[];
  /** Still on the public read once it reads Track and sheet works together. */
  shownAfterFlip: boolean;
  /** Shown only while Track has no work of its own for this one. */
  untilTrack: boolean;
  replaces: ReplacedTrackWork[];
}

interface SheetWorksResponse {
  projectId: string;
  overrideActive: boolean;
  boundary: string | null;
  works: SheetWork[];
}

const sheetWorksKey = (projectId: string) => ['sheet-works', projectId] as const;

/** Never undefined: a `{}` body, which the e2e smoke sends for any path without a fixture, reads as no works. */
async function fetchSheetWorks(projectId: string, signal: AbortSignal): Promise<SheetWork[]> {
  const body = await api<Partial<SheetWorksResponse> | null>(
    `/projects/${encodeURIComponent(projectId)}/sheet-works`,
    { signal, timeoutMs: READ_TIMEOUT_MS },
  );
  return Array.isArray(body?.works) ? body.works : [];
}

/** Business spreadsheet works stored for one project, test environments only. */
export function useSheetWorks(projectId: string) {
  return useQuery({
    queryKey: sheetWorksKey(projectId),
    queryFn: ({ signal }) => fetchSheetWorks(projectId, signal),
    enabled: !!projectId,
    staleTime: 5 * 60_000,
  });
}
