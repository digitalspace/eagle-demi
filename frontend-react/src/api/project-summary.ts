import { useQuery } from '@tanstack/react-query';
import { ApiError, api, type ApiInit } from './client';
import { trackException } from '../telemetry';

/**
 * A lookup field as the project record actually carries it: a bare Eagle `List` ObjectId, a
 * `{_id, name}` pair the Track backfill wrote, or the plain name. `resolveListLabel` takes all three.
 */
export type ListRef = string | { _id?: string; name?: string } | null;

/** One lookup field after resolution. Never an id unless `unresolved` says so. */
export interface ResolvedLabel {
  text: string;
  /** `text` is a raw id: the lookup landed and held no row for it. */
  unresolved: boolean;
  /** The lookup has not landed, so `text` is empty rather than an id shown and then swapped. */
  pending: boolean;
}

/** Several resolved labels rendered as one line, with the tooltip for any id still on show. */
export interface LabelLine {
  text: string;
  pending: boolean;
  /** Empty when everything resolved, so the `title` attribute can be dropped. */
  title: string;
  parts: ResolvedLabel[];
}

/** An Eagle ObjectId. Anything else in a lookup field is already the label. */
const OBJECT_ID = /^[0-9a-f]{24}$/i;

/** Said to a reader who is looking at an id, so the page never shows one without saying why. */
const UNRESOLVED_HINT = 'Not in the registry’s list of names: ';

/**
 * Rows to ask for in the one `List` read. There are about 250 and the page is staff-only, so this
 * fits in a single request — the API caps a page at 1000 and refuses over 100 anonymously.
 */
const LIST_PAGE_SIZE = 1000;

/** Said in place of a list the read could not deliver, so an outage never reads as an empty registry. */
export const PROJECT_LIST_ERROR = 'The project list could not be loaded. Reload the page to try again.';

/**
 * Turn one stored lookup value into a label.
 *
 * @param lists  id -> name, or null while the lookup is still in flight.
 */
export function resolveListLabel(value: ListRef | undefined, lists: Map<string, string> | null): ResolvedLabel {
  if (value === null || value === undefined) return { text: '', unresolved: false, pending: false };

  if (typeof value === 'object') {
    const name = (value.name || '').trim();
    if (name) return { text: name, unresolved: false, pending: false };
    return resolveListLabel(value._id ?? null, lists);
  }

  const text = String(value).trim();
  // Not an id, so it is the label already: mock fixtures, Track's own string columns and any
  // record the backfill resolved all land here untouched.
  if (!text || !OBJECT_ID.test(text)) return { text, unresolved: false, pending: false };

  // Withheld rather than shown and swapped a moment later — the id would flash on every load.
  if (!lists) return { text: '', unresolved: false, pending: true };

  const name = lists.get(text);
  return name
    ? { text: name, unresolved: false, pending: false }
    : { text, unresolved: true, pending: false };
}

/** Resolve several lookup values and render them as one line. */
export function joinLabels(
  values: (ListRef | undefined)[],
  lists: Map<string, string> | null,
  separator: string,
): LabelLine {
  const parts = values.map((value) => resolveListLabel(value, lists));
  const unresolved = parts.filter((part) => part.unresolved).map((part) => part.text);
  return {
    text: parts
      .map((part) => part.text)
      .filter(Boolean)
      .join(separator),
    pending: parts.some((part) => part.pending),
    title: unresolved.length ? UNRESOLVED_HINT + unresolved.join(', ') : '',
    parts,
  };
}

interface SearchRow {
  id?: string | number;
  _id?: string | number;
  name?: string;
}

interface SearchEnvelope {
  searchResults?: SearchRow[];
}

/**
 * Every Eagle `List` row as id -> name, in one request.
 *
 * The project record stores List ObjectIds in `currentPhaseName` and friends, so without this the
 * page renders ids. A failed read gives an empty table rather than a retry: ids then render with
 * the tooltip that explains them, which is a worse page than names but still the page.
 */
export async function fetchLists(init?: ApiInit): Promise<Map<string, string>> {
  try {
    const body = await api<SearchEnvelope[]>(`/search?dataset=List&pageSize=${LIST_PAGE_SIZE}`, init);
    const rows = body?.[0]?.searchResults || [];
    // A nameless row is dropped rather than mapped to '': an id with its "not in the list"
    // tooltip says more than a blank.
    return new Map(rows.filter((row) => row.name).map((row) => [String(row.id ?? row._id), String(row.name)]));
  } catch (err) {
    trackException(err, { lookup: 'List' });
    return new Map();
  }
}

const listsKey = ['lists'] as const;

/** The `List` name table, read once per session and shared by the picker and the summary page. */
export function useLists() {
  return useQuery({ queryKey: listsKey, queryFn: ({ signal }) => fetchLists({ signal }) });
}

// The Project summary screen ------------------------------------------------------------------

/** One phase row. Eagle's `phaseHistory` is a bare name list; Track's `phases` carry dates. */
export type PhaseHistoryEntry =
  | string
  | { name?: string; phaseName?: string; date?: string; dateCompleted?: string };

/** The project record as `GET /projects/:id` returns it. Every field is rendered verbatim. */
export interface ProjectFacts {
  id: string | number;
  name: string;
  eagleId?: string;
  legacyEagleId?: string;
  proponentName?: string;
  proponent?: string;
  region?: ListRef;
  address?: string;
  legislation?: ListRef;
  legislationYear?: number | string;
  CEAAInvolvement?: ListRef;
  eacDecision?: ListRef;
  currentPhaseName?: ListRef;
  decisionDate?: string | null;
  eaCertificate?: string | null;
  phaseHistory?: PhaseHistoryEntry[];
}

/** A document the summary points at. `datePosted` is an ISO string when the index carried one. */
export interface SummaryDocumentRef {
  documentId: string;
  displayName: string;
  datePosted?: string | null;
}

export type KeyDocumentRole =
  | 'certificate'
  | 'scheduleA'
  | 'scheduleB'
  | 'amendedCertificate'
  | 'application'
  | 'assessmentReport';

export interface KeyDocumentRef extends SummaryDocumentRef {
  role: KeyDocumentRole;
  /** Set only when the registry held nothing else for the role, so the page says which language. */
  languageFlag?: 'fr';
}

/** Fixed, human wording per role — the API sends the role only, so the label cannot drift. */
export const KEY_DOCUMENT_LABELS: Record<KeyDocumentRole, { label: string; note: string }> = {
  certificate: { label: 'EA certificate', note: 'The certificate as originally issued.' },
  scheduleA: { label: 'Schedule A', note: 'The certified project description.' },
  scheduleB: { label: 'Schedule B', note: 'The table of conditions summarised above.' },
  amendedCertificate: { label: 'Amended certificate', note: 'The most recent amended certificate.' },
  application: { label: 'Application materials', note: 'The proponent’s application, as submitted.' },
  assessmentReport: { label: 'Assessment report', note: 'The EAO’s assessment of the application.' },
};

export interface SummaryCountBlock {
  count: number;
  latest?: SummaryDocumentRef | null;
}

export interface ProjectSummaryFacts {
  documentTotal?: number;
  amendments?: SummaryDocumentRef[];
  inspections?: SummaryCountBlock;
  selfReports?: SummaryCountBlock;
  keyDocuments?: KeyDocumentRef[];
}

/** A `[n]` marker, resolved server-side to a real chunk. The model never sees a chunk id. */
export interface ProjectSummaryCitation {
  n: number;
  chunkId: string;
  documentId: string;
  pageNumber: number;
  documentName: string;
  /** Absent means DEMI. `iaac` documents carry ids like `iaac:158078` that resolve nowhere here. */
  source?: 'demi' | 'iaac';
  /** The registry PDF, the only way to reach an `iaac` source. Set with `source: 'iaac'`. */
  url?: string;
  /** What `url` opens: an older decision is a registry page, not a file. Absent means a file. */
  format?: 'pdf' | 'html';
}

export interface StatusSection {
  sentence: string;
  citations?: number[];
}

export interface ConditionItem {
  n: number;
  category: string;
  title: string;
  oneLiner: string;
  bullets?: string[];
  citations?: number[];
}

export interface ConditionsSection {
  sourceDocumentId?: string;
  items: ConditionItem[];
}

export interface AmendmentNote {
  documentId: string;
  sentence: string;
  citations?: number[];
}

export interface TimelineEventNote {
  date: string;
  label: string;
  citations?: number[];
}

export interface ComplianceSection {
  sourceDocumentId?: string;
  paragraph: string;
  citations?: number[];
}

/** `organizationId` null means the extracted name matched no Organization row — see the join. */
export interface NationNote {
  name: string;
  organizationId: string | null;
  citations?: number[];
}

/** One row of the IAAC registry's document list. `docId` is a registry id, not a DEMI one. */
export interface FederalDocumentRef {
  title: string;
  date: string | null;
  docId: string;
}

export interface FederalDecisionRef extends FederalDocumentRef {
  /** Null for a decision the registry never filed as a file: `pageUrl` is then the only link. */
  pdfUrl: string | null;
  /** The registry's document page, which prints an older decision instead of linking a PDF. */
  pageUrl?: string | null;
  format?: 'pdf' | 'html' | null;
  /** Absent when the PDF was found but could not be read, which is a reason of its own. */
  pageCount?: number;
}

/** What the federal registry says about the project, read at generation time, never from a model. */
export interface FederalFacts {
  status: string | null;
  cearId: string;
  projectUrl: string;
  latest: FederalDocumentRef | null;
  decision?: FederalDecisionRef;
}

export interface FederalSection extends ConditionsSection {
  source?: 'demi' | 'iaac';
  facts?: FederalFacts;
  reason?: 'no_federal_decision' | 'federal_decision_unreadable' | 'no_conditions';
}

export interface ProjectSummarySections {
  status?: StatusSection | null;
  conditions?: ConditionsSection | null;
  amendments?: AmendmentNote[] | null;
  timelineEvents?: TimelineEventNote[] | null;
  compliance?: ComplianceSection | null;
  nations?: NationNote[] | null;
  federal?: FederalSection | null;
}

export interface ProjectSummaryRecord {
  id: string;
  projectId: string;
  eagleId?: string | null;
  generatedAt: string;
  sourceAccess?: 'public';
  /** Null when no section reached the model — a record made entirely of facts. */
  model: string | null;
  pricedAs?: string;
  promptVersion?: number;
  usage?: { promptTokens?: number; completionTokens?: number };
  /** Null on a record whose sections were all facts, so nothing was priced. */
  estimatedCostCad?: number | null;
  facts?: ProjectSummaryFacts;
  sections?: ProjectSummarySections;
  citations?: ProjectSummaryCitation[];
  /** Why a section is absent, by section name. `not_extracted` means the text is still queued. */
  sectionErrors?: Record<string, string | undefined>;
  /** The document a `not_extracted` section waits on, so the page can link the file regardless. */
  sectionSources?: Record<string, SummaryDocumentRef | undefined>;
}

/** A `lists` row of kind Organization, companyType "Indigenous Group". Address is never modelled. */
export interface OrganizationRow {
  id: string;
  name: string;
  companyType?: string;
  address1?: string;
  city?: string;
  province?: string;
  postal?: string;
  country?: string;
  website?: string;
}

/** One row of the merged timeline: fact rows and AI-extracted rows render the same, marked apart. */
export interface TimelineRow {
  key: string;
  date: string | null;
  label: string;
  kind: 'phase' | 'decision' | 'amendment' | 'ai';
  citations?: number[];
  /** Set only on a phase row whose `List` id the lookup could not place. */
  title?: string;
}

/**
 * Why there is no generated summary. `null` alongside a record means there is one.
 * `signin` is a gate, not a failure: the route is staff-only.
 */
export type SummaryReason = 'missing' | 'disabled' | 'error' | 'signin';

const projectFactsKey = (projectId: string) => ['project-facts', projectId] as const;
/** `isStaff` is part of the key: a signed-out session's `signin` answer is not the staff answer. */
const projectSummaryKey = (projectId: string, isStaff: boolean) =>
  ['project-summary', projectId, isStaff] as const;
const organizationsKey = ['organizations'] as const;

export async function fetchProjectFacts(projectId: string, init?: ApiInit): Promise<ProjectFacts> {
  try {
    return await api<ProjectFacts>(`/projects/${encodeURIComponent(projectId)}`, init);
  } catch (err) {
    if (err instanceof ApiError) {
      // Same answer for "not readable" and "not there", for the reason fetchDocument gives:
      // telling them apart would disclose that a hidden row exists.
      if (err.status === 403 || err.status === 404) {
        throw new Error('That project is not in the registry, or you do not have access to it.');
      }
      throw new Error(`Could not load the project (HTTP ${err.status}).`);
    }
    throw err;
  }
}

/** A `{summary: null, reason}` body, which is the switched-off shape `/search/summary` already uses. */
interface SummaryEnvelope {
  summary?: unknown;
  reason?: string;
}

/**
 * The stored summary row, or the reason there is none.
 *
 * Never rejects: a 404, a switched-off environment and a failed read are all answers this page
 * states out loud, and none of them stop the facts above from being the page.
 */
export async function fetchProjectSummary(
  projectId: string,
  init?: ApiInit,
): Promise<{ record: ProjectSummaryRecord | null; reason: SummaryReason | null }> {
  try {
    const body = await api<(ProjectSummaryRecord & SummaryEnvelope) | null>(
      `/projects/${encodeURIComponent(projectId)}/summary`,
      init,
    );
    if (!body || body.summary === null || body.reason) {
      return { record: null, reason: body?.reason === 'disabled' ? 'disabled' : 'missing' };
    }
    return { record: body, reason: null };
  } catch (err) {
    if (err instanceof ApiError) {
      // The documented "no row generated yet" answer, not an error worth an alert.
      if (err.status === 404) return { record: null, reason: 'missing' };
      // The token was held at the gate and rejected here: it expired mid-visit. Still a sign-in gate.
      if (err.status === 401 || err.status === 403) return { record: null, reason: 'signin' };
    }
    trackException(err, { read: 'project-summary' });
    return { record: null, reason: 'error' };
  }
}

interface RawOrganization extends Omit<OrganizationRow, 'id' | 'name'> {
  id?: string | number;
  _id?: string | number;
  name?: string;
}

/**
 * Every Indigenous Group Organization row, indexed by id.
 *
 * Address and website come from here and never from the model: a contact detail a model wrote is a
 * contact detail nobody verified. A failed read costs the cards their detail, not the section.
 */
export async function fetchOrganizations(init?: ApiInit): Promise<Map<string, OrganizationRow>> {
  try {
    const body = await api<{ searchResults?: RawOrganization[] }[]>(
      '/search?dataset=Organization&and[companyType]=Indigenous Group&pageSize=500',
      init,
    );
    const rows = body?.[0]?.searchResults || [];
    // `id` before `_id`: the generator stores `organizationId` from this same endpoint's `id`, so
    // indexing on anything else would join nothing.
    return new Map(
      rows.map((row) => {
        const id = String(row.id ?? row._id);
        return [id, { ...row, id, name: row.name || '' }];
      }),
    );
  } catch (err) {
    trackException(err, { lookup: 'Organization' });
    return new Map<string, OrganizationRow>();
  }
}

/**
 * The reads behind one project's summary page.
 *
 * Three independent legs, never a group: facts render on their own, and a missing or switched-off
 * summary is a normal answer, so a slow Organization list of 246 rows holds up neither.
 */
export function useProjectFacts(projectId: string) {
  return useQuery({
    queryKey: projectFactsKey(projectId),
    queryFn: ({ signal }) => fetchProjectFacts(projectId, { signal }),
    enabled: !!projectId,
  });
}

/**
 * @param isStaff  Gate, not a permission check. An anonymous request would 401 into the client's
 *                 refresh-and-replay and read on the page as a failure, so it is never sent.
 */
export function useProjectSummary(projectId: string, isStaff: boolean) {
  return useQuery({
    queryKey: projectSummaryKey(projectId, isStaff),
    queryFn: ({ signal }) =>
      isStaff
        ? fetchProjectSummary(projectId, { signal })
        : Promise.resolve({ record: null, reason: 'signin' as SummaryReason }),
    enabled: !!projectId,
  });
}

export function useOrganizations() {
  return useQuery({ queryKey: organizationsKey, queryFn: ({ signal }) => fetchOrganizations({ signal }) });
}
