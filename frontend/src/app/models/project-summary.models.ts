/**
 * The two halves of the Project summary screen.
 *
 * `ProjectFacts` is the project record as `GET /projects/:id` returns it — every field comes from
 * Track or Eagle and is rendered verbatim.
 *
 * `ProjectSummaryRecord` is the stored row from the `projectSummaries` container, generated
 * offline by `src/scripts/generate-project-summary.js` and only read here. Its `facts` block is
 * computed by code from the documents index at generation time; its `sections` block is the model
 * output, and every claim in it carries citation numbers that resolve against `citations`.
 *
 * Everything below the top level is optional or nullable on purpose: a section whose source
 * document was missing at generation time is `null`, and the page hides it rather than inventing
 * one. Wire shape, so nothing here is a class.
 */

/**
 * A lookup field as the project record actually carries it.
 *
 * Three shapes reach this page. eagle-api's push resolves only `proponent`, `pins` and
 * `applicableRegulation` (`api/helpers/demiPush.js`), so every other lookup field arrives as a
 * bare Eagle `List` ObjectId; the Track backfill wrote some of them as `{_id, name}`; and the mock
 * fixture carries the plain name. `resolveListLabel` in the service turns all three into a label.
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
  /** Empty when everything resolved — bind through `[attr.title]` so the attribute disappears. */
  title: string;
  /** The labels behind `text`, for a caller that renders them one element each. */
  parts: ResolvedLabel[];
}

/** One phase row. Eagle's `phaseHistory` is a bare name list; Track's `phases` carry dates. */
export type PhaseHistoryEntry = string | { name?: string; phaseName?: string; date?: string; dateCompleted?: string };

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

/**
 * One row of the project picker: only what the list renders.
 *
 * The three descriptive fields are `ListRef` rather than `string` because the search response
 * carries whichever shape the record was written in — a resolved `{_id, name}` for `proponent`,
 * a plain name for `region`, an Eagle `List` id for a phase the backfill did not resolve. They go
 * through the same `resolveListLabel` the summary page uses, so a row never renders an id.
 */
export interface ProjectListRow {
  id: string;
  name: string;
  region?: ListRef;
  proponent?: ListRef;
  currentPhaseName?: ListRef;
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
  assessmentReport: { label: 'Assessment report', note: 'The EAO’s assessment of the application.' }
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
  pdfUrl: string;
  /** Absent when the PDF was found but could not be read, which is a reason of its own below. */
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

/**
 * The federal section, from either registry.
 *
 * A `demi` section resolves to a document in this service; an `iaac` one does not, and carries the
 * registry facts and links instead. Either reason leaves `items` empty with the facts intact: the
 * registry answered, and what it answered — no decision, or one whose text would not read — is
 * itself worth showing, so the page states it rather than claiming nothing is known.
 */
export interface FederalSection extends ConditionsSection {
  source?: 'demi' | 'iaac';
  facts?: FederalFacts;
  reason?: 'no_federal_decision' | 'federal_decision_unreadable';
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
  /** The access every cited document satisfied. Always `public`; the API stores nothing else. */
  sourceAccess?: 'public';
  /** Null when no section reached the model — a record made entirely of facts. */
  model: string | null;
  /** The rate card the cost estimate was priced against, which need not be `model`. */
  pricedAs?: string;
  promptVersion?: number;
  usage?: { promptTokens?: number; completionTokens?: number };
  estimatedCostCad?: number;
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
