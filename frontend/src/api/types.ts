/** Track and Eagle attribute bags, carried through untouched for the screens that read them. */
export interface RawMetadata {
  trackAttributes?: Record<string, unknown>;
  eagleAttributes?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Project {
  _id?: string;
  id: string | number;
  trackProjectId?: number | string;
  name: string;
  // Optional because the API redacts by caller level: only `id` and `name` survive every level.
  sector?: string;
  status?: string;
  legacyEagleId?: string;
  centroid?: [number, number]; // [longitude, latitude]
  gatingState: 'admitted' | 'staged';
  region?: string;
  regionalDistrict?: string;
  municipality?: string;
  electoralDistrict?: string;
  description?: string;
  proponent?: string;
  /**
   * Track's `ea_certificate`, verbatim. Certificate STATE, not just a number: a real one
   * ("E98-05", "WD09-01") or a word ("Withdrawn", "In progress", "N/A"). Most projects have none.
   */
  // null = known absent (Cosmos said so); undefined = source did not carry the field.
  eaCertificate?: string | null;
  /**
   * Pre-escaped `<mark>` markup from AI Search, per field — what the index's own analyzer matched,
   * which is not the same as what a regex in the browser can find. Absent on the Cosmos fallback
   * path, where there is no analyzer to ask, so a renderer must fall back to client marking.
   */
  highlighted?: { name?: string; description?: string };
  rawMetadata?: RawMetadata;
  sources?: {
    track?: unknown;
    eagle?: unknown;
    /** Written by `src/scripts/sync-wildfires.js` (manual sync — may be stale). */
    wildfire?: {
      activeCountWithin50km: number;
      nearestDistanceKm: number | null;
      firesOfNoteNearby: number;
      lastCalculatedAt: string;
    };
  };
}

export interface Document {
  id: string | number;
  displayName: string;
  documentFileName: string;
  documentType?: string;
  orcsCode?: string;
  projectId: string | number;
  projectName?: string;
  gatingState: 'admitted' | 'staged';
  textSnippet: string;
  /** See `Project.highlighted`. Empty when the frontend substituted its own text for the field. */
  highlighted?: { displayName?: string; textSnippet?: string };
}

/** A `/search` project row before mapping. Every field is optional: the API redacts by level. */
export interface RawProject {
  _id?: string;
  id?: string | number;
  trackProjectId?: string | number;
  legacyEagleId?: string;
  name?: string;
  sector?: string;
  status?: string;
  region?: string;
  description?: string;
  centroid?: unknown;
  isPublished?: boolean;
  eaCertificate?: string | null;
  responsibleEPD?: string;
  leadAgency?: string;
  eaDecisionDate?: string | null;
  proponent?: string | { name?: string };
  highlighted?: { name?: string; description?: string };
  metadata?: RawMetadata;
  sources?: Project['sources'];
}

/** A `/search` document row before mapping. */
export interface RawDocument {
  _id?: string;
  displayName?: string;
  documentFileName?: string;
  documentType?: string;
  type?: string;
  orcsClassification?: string;
  s3Key?: string;
  projectId?: string | number;
  project?: string | { _id?: string };
  projectName?: string;
  documentSource?: string;
  datePosted?: string;
  description?: string;
  textSnippet?: string;
  isPublished?: boolean;
  highlighted?: { displayName?: string; description?: string };
}
