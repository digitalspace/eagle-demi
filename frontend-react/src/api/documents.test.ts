import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { AppConfig } from '../config';
import { json, respond, urlOf } from '../test-http';
import { queryWrapper } from '../test-query';
import { epicPublicDownloadUrl, fetchDocument, getDownloadUrl, mapDocument, useDocuments } from './documents';
import type { Project } from './types';
import { localIso } from '../test-dates';

vi.mock('./keycloak', () => ({
  getToken: () => 'staff-token',
  refreshToken: async () => true,
}));

/** A seeded document reuses its Eagle ObjectId, which is what says EPIC has the same file. */
const SEEDED_ID = `${'a'.repeat(23)}1`;
/** A DEMI-native upload. Its id names nothing on EPIC. */
const NATIVE_ID = 'doc-0f2b-native';

async function boot(env: AppConfig = { API_PATH: '/api', API_LOCATION: '' }) {
  respond();
  window.__env = env;
  const { initConfig } = await import('../config');
  await initConfig();
}

beforeEach(() => boot());

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.__env;
});

describe('mapping a document row', () => {
  const projects = [{ id: '10001', legacyEagleId: 'eagle-1', name: 'Sample Ridge Wind Farm' }] as Project[];

  it('resolves the project name from the loaded corpus', () => {
    const row = mapDocument({ _id: 'd1', displayName: 'Report.pdf', projectId: '10001' }, projects);

    expect(row.projectName).toBe('Sample Ridge Wind Farm');
  });

  it('matches a row that carries the legacy Eagle id instead', () => {
    const row = mapDocument({ _id: 'd1', projectId: 'eagle-1' }, projects);

    expect(row.projectName).toBe('Sample Ridge Wind Farm');
  });

  it('falls back to a placeholder name when the project is not loaded', () => {
    const row = mapDocument({ _id: 'd1', projectId: 'unknown' }, projects);

    expect(row.projectName).toBe('Associated Project');
  });

  it('takes the project id from the row, not the nested project object', () => {
    const row = mapDocument({ _id: 'd1', projectId: '10001', project: { _id: 'eagle-1' } }, projects);

    expect(row.projectId).toBe('10001');
  });

  it('names an untitled document rather than rebuilding one from the file name', () => {
    expect(mapDocument({ _id: 'd1' }, []).displayName).toBe('Untitled Document');
    expect(mapDocument({ _id: 'd1', documentFileName: 'report.pdf' }, []).displayName).toBe('report.pdf');
  });

  it('takes the file name from the storage key when the row carries none', () => {
    const row = mapDocument({ _id: 'd1', s3Key: 'bucket/prefix/report.pdf' }, []);

    expect(row.documentFileName).toBe('report.pdf');
  });

  it('never invents a record number', () => {
    expect(mapDocument({ _id: 'd1' }, []).orcsCode).toBe('');
  });

  it('rebuilds the subline from real metadata when the description is a placeholder', () => {
    const row = mapDocument(
      {
        _id: 'd1',
        description: 'Official document extracted from central registry.',
        documentSource: 'Sample Source',
        type: 'Letter',
        datePosted: localIso(2026, 2, 4),
        highlighted: { description: '<mark>Official</mark>' },
      },
      [],
    );

    expect(row.textSnippet).toBe('Sample Source · Letter · 2026-03-04');
    // The text was replaced, so marking inside it would point at words we wrote.
    expect(row.highlighted?.textSnippet).toBe('');
  });

  // The API sends a day for some rows and a full instant for others; a day must not slide back one
  // in BC, where UTC midnight is still the previous afternoon.
  it('reads a date-only posting date as the day it says', () => {
    const row = mapDocument(
      { _id: 'd1', description: 'Unnamed Document', documentSource: 'Sample Source', datePosted: '2026-03-04' },
      [],
    );

    expect(row.textSnippet).toBe('Sample Source · 2026-03-04');
  });

  it('keeps a real description and its markup', () => {
    const row = mapDocument(
      { _id: 'd1', description: 'A real summary.', highlighted: { description: 'A <mark>real</mark> summary.' } },
      [],
    );

    expect(row.textSnippet).toBe('A real summary.');
    expect(row.highlighted?.textSnippet).toBe('A <mark>real</mark> summary.');
  });

  it('marks an unpublished document staged', () => {
    expect(mapDocument({ _id: 'd1', isPublished: false }, []).gatingState).toBe('staged');
    expect(mapDocument({ _id: 'd1', isPublished: true }, []).gatingState).toBe('admitted');
  });
});

describe('fetchDocument', () => {
  it('returns the document', async () => {
    respond(json({ id: 'd1', displayName: 'Report.pdf' }));

    expect(await fetchDocument('d1')).toMatchObject({ id: 'd1' });
  });

  it('scopes the read to a project when one is given', async () => {
    const fetchMock = respond(json({ id: 'd1' }));

    await fetchDocument('d1', '10001');

    expect(urlOf(fetchMock.mock.calls[0]!)).toContain('/api/documents/d1?project=10001');
  });

  it('answers null for a document the reader may not see or that is gone', async () => {
    // Twice: the client refreshes the token and replays once before a 403 stands.
    respond(json({}, 403), json({}, 403));
    expect(await fetchDocument('d1')).toBeNull();

    respond(json({}, 404));
    expect(await fetchDocument('d1')).toBeNull();
  });

  it('raises anything else', async () => {
    respond(json({}, 500));

    await expect(fetchDocument('d1')).rejects.toThrow('Could not load the document (HTTP 500).');
  });
});

describe('getDownloadUrl', () => {
  it('returns the presigned link the API minted', async () => {
    respond(json({ url: 'https://storage.example/presigned' }));

    expect(await getDownloadUrl(SEEDED_ID)).toBe('https://storage.example/presigned');
  });

  it('scopes the request to a project when one is given', async () => {
    const fetchMock = respond(json({ url: 'https://storage.example/presigned' }));

    await getDownloadUrl(NATIVE_ID, '10001');

    expect(urlOf(fetchMock.mock.calls[0]!)).toContain(
      `/api/documents/${NATIVE_ID}/download?project=10001`,
    );
  });

  it('treats a refusal as an answer, never falling back to the public copy', async () => {
    respond(json({ error: 'forbidden' }, 403), json({ error: 'forbidden' }, 403));

    await expect(getDownloadUrl(SEEDED_ID)).rejects.toThrow(
      'You do not have permission to download this document.',
    );
  });

  it('falls back to the public EPIC copy when a seeded document fails', async () => {
    respond(json({}, 500));

    expect(await getDownloadUrl(SEEDED_ID)).toBe(epicPublicDownloadUrl(SEEDED_ID));
  });

  it('raises for a DEMI-native document rather than sending the reader to a dead URL', async () => {
    respond(json({}, 500));

    await expect(getDownloadUrl(NATIVE_ID)).rejects.toThrow('Could not prepare download (HTTP 500).');
  });

  it('raises when the API answered without a link', async () => {
    respond(json({}));

    await expect(getDownloadUrl(NATIVE_ID)).rejects.toThrow('The API did not return a download link.');
  });

  it('goes straight to the public copy in demo mode, asking no API', async () => {
    await boot({ API_PATH: '/api', API_LOCATION: '', USE_MOCK_DATA: true });
    const fetchMock = respond(json({ url: 'https://storage.example/presigned' }));

    expect(await getDownloadUrl(SEEDED_ID)).toBe(epicPublicDownloadUrl(SEEDED_ID));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('useDocuments', () => {
  it('maps rows and fills project names from the project leg', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | string) => {
        const url = String(input);
        if (url.includes('dataset=Project')) {
          return json([{ searchResults: [{ _id: 'p1', id: '10001', name: 'Sample Ridge Wind Farm' }] }]);
        }
        return json([{ searchResults: [{ _id: 'd1', displayName: 'Report.pdf', projectId: '10001' }] }]);
      }),
    );

    const { result } = renderHook(() => useDocuments(''), { wrapper: queryWrapper() });

    await waitFor(() => expect(result.current.data?.[0]?.projectName).toBe('Sample Ridge Wind Farm'));
    expect(result.current.data?.[0]).toMatchObject({ id: 'd1', displayName: 'Report.pdf' });
  });
});
