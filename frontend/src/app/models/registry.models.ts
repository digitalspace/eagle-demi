export interface Project {
  id: string | number;
  name: string;
  sector: string;
  status: string;
  legacyEagleId: string;
  centroid: [number, number]; // [longitude, latitude]
  gatingState: 'admitted' | 'staged';
  region: string;
  description: string;
  proponent: string;
  rawMetadata?: any;
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
