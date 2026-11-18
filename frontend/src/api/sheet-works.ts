import { useQuery } from '@tanstack/react-query';
import { READ_TIMEOUT_MS, api } from './client';

/** A date the source left out, with the latest day it can be. Keyed by the date field it stands in for. */
export type Undated = Record<string, { notAfter: string | null }> | null;

export interface SheetInterruption {
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

/** A phase on the Workplans screen: a sheet phase plus Track's stage and state flags. */
export interface WorkplanPhase extends SheetPhase {
  stage: string | null;
  isCompleted: boolean;
  /** Track only; null on a sheet phase. */
  isSuspended: boolean | null;
  /** Track's current phase; null on a sheet phase and while Track has not sent its current phase. */
  isCurrent: boolean | null;
  /** Start of Track's open suspension; null on a sheet phase. */
  suspendedDate: string | null;
  /** Days added by extensions; null when a sheet interruption has no days. */
  extensionDays: number | null;
  /** Days added by finished suspensions; null when a sheet interruption has no days. */
  suspendedDays: number | null;
}

/** One live work, Track or sheet, as `GET /workplans` sends it. */
export interface WorkplanRow extends Omit<SheetWork, 'phases' | 'milestones'> {
  projectId: string;
  projectName: string | null;
  source: 'track' | 'sheet';
  workTypeCode: string | null;
  workState: string | null;
  isActive: boolean | null;
  /** Anticipated date of the work's last decision event while it has no actual date; null on a sheet work. */
  decisionEventDate: string | null;
  /** Sheet works only, like the two below; null on a Track row. Optional so hand-built rows in tests may leave them out. */
  certificateKind?: 'EAC' | 'PAC' | null;
  complexityCode?: 'pre-2014' | 'simple' | 'typical' | 'complex' | null;
  transitionIn?: { fromActYear: number | null; date: string | null } | null;
  phases: WorkplanPhase[];
}

// Every live work in one body, so it gets most of APIM's 30 s cap rather than the 5 s read budget.
const WORKPLANS_TIMEOUT_MS = 25_000;

async function fetchWorkplans(signal: AbortSignal): Promise<WorkplanRow[]> {
  const body = await api<{ works?: WorkplanRow[] } | null>('/workplans', { signal, timeoutMs: WORKPLANS_TIMEOUT_MS });
  return Array.isArray(body?.works) ? body.works : [];
}

/** Every live work the staff reader can see, dev and test only. The full query result, so a 404 or 403 reaches the page. */
export function useWorkplans() {
  return useQuery({
    queryKey: ['workplans'],
    queryFn: ({ signal }) => fetchWorkplans(signal),
    staleTime: 5 * 60_000,
  });
}
