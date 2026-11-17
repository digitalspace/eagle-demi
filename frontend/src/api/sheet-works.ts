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
    staleTime: 5 * 60_000,
  });
}

/** Sheet work counts for one project: works per Act, and works the public read would treat differently. */
export interface SheetWorksSummary {
  projectId: string;
  act1996: number;
  act2002: number;
  hidden: number;
  replaces: number;
  untilTrack: number;
}

const NO_SUMMARY = new Map<string, SheetWorksSummary>();

async function fetchSheetWorksSummary(signal: AbortSignal): Promise<Map<string, SheetWorksSummary>> {
  const body = await api<{ projects?: SheetWorksSummary[] } | null>('/sheet-works/summary', {
    signal,
    timeoutMs: READ_TIMEOUT_MS,
  });
  const rows = Array.isArray(body?.projects) ? body.projects : [];
  return new Map(rows.map((row) => [String(row.projectId), row]));
}

/**
 * Sheet work counts for every project the reader can see, keyed by project id. Empty while loading
 * and on any failure: the route is served in dev and test only, and staff only.
 */
export function useSheetWorksSummary(): Map<string, SheetWorksSummary> {
  const { data } = useQuery({
    queryKey: ['sheet-works-summary'],
    queryFn: ({ signal }) => fetchSheetWorksSummary(signal),
    staleTime: 5 * 60_000,
  });
  return data ?? NO_SUMMARY;
}
