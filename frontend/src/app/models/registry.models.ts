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
  rawMetadata?: any;
  sources?: {
    track?: any;
    eagle?: any;
    nrpti?: { recordCount?: number; orderCount?: number; inspectionCount?: number; ticketCount?: number; count?: number; records?: any[] };
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
}
