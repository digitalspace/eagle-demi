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
    nrpti?: { recordCount?: number; orderCount?: number; inspectionCount?: number; ticketCount?: number; count?: number; records?: any[]; complianceStatus?: string; lastRecordDate?: string };
    wildfire?: { count?: number; activeNearby?: boolean; nearestDistanceKm?: number; wildfires?: any[] };
  };
  nrptiRecords?: any[];
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
