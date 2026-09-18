import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { config } from '../config';
import { ApiError, api } from './client';
import { searchDataset, searchRetry } from './search';
import { useProjects } from './projects';
import { trackException } from '../telemetry';
import type { Document, Project, RawDocument } from './types';

/** Where the same document sits on the public EPIC site, outside DEMI's presigned storage. */
const EPIC_PUBLIC_DOCUMENT_BASE = 'https://projects.eao.gov.bc.ca/api/public/document';

export const epicPublicDownloadUrl = (documentId: string): string =>
  `${EPIC_PUBLIC_DOCUMENT_BASE}/${encodeURIComponent(documentId)}/download`;

/**
 * An Eagle ObjectId. Seeded rows reuse it as their DEMI id, so it is also what says a document
 * exists on the public EPIC site; a DEMI-native upload carries a uuid and exists nowhere else.
 */
export const EAGLE_OBJECT_ID = /^[0-9a-f]{24}$/i;

export const documentsKey = (query: string) => ['search', 'Document', query] as const;

/** The API's own placeholders. A rebuilt subline beats echoing them back to the reader. */
const PLACEHOLDER_SNIPPET =
  /^(Unnamed Document|Untitled Document|No project description provided|Official document extracted from central registry\.?)$/;

export function mapDocument(d: RawDocument, projects: Project[]): Document {
  // `projectId` is the DEMI id. Taking it from `project._id` compares across id-spaces, which read
  // every per-project document count as 0; the fallbacks are for a rolled-back API only.
  const raw = d.project;
  const projectId = d.projectId || (typeof raw === 'string' ? raw : raw?._id) || '';
  const matched = projects.find((p) => p.id === projectId || p.legacyEagleId === projectId);

  // Placeholder names stay as they are; a title rebuilt from "document.pdf" read "Document Document".
  const displayName = d.displayName || d.documentFileName || 'Untitled Document';

  // Never invent a description. The API's own placeholder is dropped too, and the subline falls
  // back to real metadata: source, type, date posted.
  let textSnippet = d.description || d.textSnippet || '';
  let snippetHtml = d.highlighted?.description || '';
  if (!textSnippet || PLACEHOLDER_SNIPPET.test(textSnippet)) {
    const posted = d.datePosted ? new Date(d.datePosted).toLocaleDateString('en-CA') : '';
    textSnippet = [d.documentSource, d.type !== 'None' ? d.type : '', posted].filter(Boolean).join(' · ');
    snippetHtml = '';
  }

  return {
    id: d._id ?? '',
    displayName,
    documentFileName: d.documentFileName || (d.s3Key ? (d.s3Key.split('/').pop() ?? '') : ''),
    documentType: d.documentType || 'Document',
    // Never invent a record number — a mock ORCS code rendered to users as a real classification.
    orcsCode: d.orcsClassification || '',
    projectId,
    projectName: matched ? matched.name : d.projectName || 'Associated Project',
    gatingState: d.isPublished === false ? 'staged' : 'admitted',
    textSnippet,
    highlighted: { displayName: d.highlighted?.displayName || '', textSnippet: snippetHtml },
  };
}

/**
 * The document corpus for a query.
 *
 * The project leg runs alongside rather than before it: a document row carries a project NAME
 * resolved against that list, so the names fill in when it lands instead of holding this request.
 */
export function useDocuments(query = '') {
  const projects = useProjects(query);
  const documents = useQuery({
    queryKey: documentsKey(query),
    queryFn: () => searchDataset<RawDocument>('Document', query),
    ...searchRetry,
  });

  const rows = documents.data?.searchResults;
  const loaded = projects.data?.projects;
  const data = useMemo(
    () => (rows ? rows.map((d) => mapDocument(d, loaded ?? [])) : undefined),
    [rows, loaded],
  );

  return { ...documents, data };
}

/** One document by id. Null when the reader may not see it or it does not exist. */
export async function fetchDocument(
  documentId: string,
  projectId?: string,
): Promise<Document | null> {
  const query = projectId ? `?project=${encodeURIComponent(projectId)}` : '';
  try {
    return await api<Document>(`/documents/${encodeURIComponent(documentId)}${query}`);
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 403 || err.status === 404) return null;
      throw new Error(`Could not load the document (HTTP ${err.status}).`);
    }
    throw err;
  }
}

/** One warning per session, not one per click, when the presigned leg is down. */
let downloadFallbackWarned = false;

/**
 * Ask the API for a short-lived presigned URL for a document's stored file.
 *
 * Two paths end at the public EPIC copy instead: demo mode, which has no API to ask, and a
 * presigned request that failed on a SEEDED document, whose DEMI id is the Eagle id. A DEMI-native
 * upload's uuid names nothing on EPIC, so that failure is raised rather than sent to a dead URL.
 */
export async function getDownloadUrl(documentId: string, projectId?: string): Promise<string> {
  if (config().USE_MOCK_DATA) return epicPublicDownloadUrl(documentId);

  const query = projectId ? `?project=${encodeURIComponent(projectId)}` : '';
  let presigned: string | null = null;
  let failure: unknown = null;

  try {
    const body = await api<{ url?: string } | null>(
      `/documents/${encodeURIComponent(documentId)}/download${query}`,
    );
    presigned = body?.url || null;
    if (!presigned) failure = new Error('The API did not return a download link.');
  } catch (err) {
    // A 403 is an answer, not an outage: this reader may not have the document, and the public
    // copy is not the way around that.
    if (err instanceof ApiError && err.status === 403) {
      throw new Error('You do not have permission to download this document.');
    }
    failure =
      err instanceof ApiError ? new Error(`Could not prepare download (HTTP ${err.status}).`) : err;
  }

  if (presigned) return presigned;

  if (!EAGLE_OBJECT_ID.test(documentId)) {
    throw failure instanceof Error ? failure : new Error('Could not prepare download.');
  }

  if (!downloadFallbackWarned) {
    downloadFallbackWarned = true;
    trackException(failure, { download: 'presigned-unavailable', fallback: 'epic-public' });
  }
  return epicPublicDownloadUrl(documentId);
}
