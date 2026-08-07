export interface Project {
  _id?: string;
  id: string | number;
  trackProjectId?: number | string;
  name: string;
  sector: string;
  status: string;
  legacyEagleId: string;
  centroid: [number, number]; // [longitude, latitude]
  gatingState: 'admitted' | 'staged';
  region: string;
  regionalDistrict?: string;
  municipality?: string;
  electoralDistrict?: string;
  description: string;
  proponent: string;
  /**
   * Pre-escaped `<mark>` markup from AI Search, per field — what the index's own analyzer matched,
   * which is not the same as what a regex in the browser can find. Absent on the Cosmos fallback
   * path, where there is no analyzer to ask, so a renderer must fall back to client marking.
   */
  highlighted?: { name?: string; description?: string };
  rawMetadata?: any;
  sources?: {
    track?: any;
    eagle?: any;
    wildfire?: { count?: number; activeNearby?: boolean; nearestDistanceKm?: number; wildfires?: any[] };
  };
}

export interface Document {
  id: string | number;
  displayName: string;
  documentFileName: string;
  documentType: string;
  orcsCode: string;
  projectId: string | number;
  projectName: string;
  gatingState: 'admitted' | 'staged';
  textSnippet: string;
  /** See `Project.highlighted`. Empty when the frontend substituted its own text for the field. */
  highlighted?: { displayName?: string; textSnippet?: string };
}

/**
 * A passage of extracted text from inside a document — the unit Deep Search matches on.
 * `snippet` is Typesense's highlighted span; `content` is the whole passage it came from.
 */
export interface DocumentChunk {
  id: string;
  documentId: string;
  projectId: string | number;
  projectName: string;
  documentName: string;
  documentType: string;
  pageNumber: number;
  content: string;
  snippet: string;
}

/**
 * One `[n]` citation in an AI summary, resolved back to the chunk it points at.
 *
 * The model only ever emits a source NUMBER — it never sees a chunk id, so it cannot invent one.
 * The API maps those numbers back to real ids before they reach the browser, which is what lets the
 * panel render a citation as a link rather than as bare text.
 */
export interface SummaryCitation {
  n: number;
  chunkId: string;
  documentId: string;
  projectId: string;
  pageNumber: number;
  /**
   * Hydrated server-side, under the caller's access, for cited chunks only. Names are a disclosure
   * about the row they describe, so they are resolved behind the same ACL rather than joined in the
   * browser from a separate search response.
   */
  documentName: string;
  projectName: string;
}
