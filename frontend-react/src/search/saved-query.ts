/**
 * How a saved query reads and where it opens. Shared by the grid toolbar and the account screen,
 * so both name a query the same way and replay it through the same address.
 */

import type { SavedQuery } from '../api/me';

type RecordType = 'projects' | 'documents' | 'activities' | 'notifications';

/** Record type to the label the grid shows — frontend/src/app/search/record-types/*. */
const RECORD_LABELS: Record<RecordType, string> = {
  projects: 'Projects',
  documents: 'Documents',
  activities: 'Activities & updates',
  notifications: 'Project notifications',
};

/** What a bare /search lists. */
const DEFAULT_RECORD: RecordType = 'documents';

/** URL keys the grid owns. Anything else on the query string is a filter id. */
const RESERVED_PARAMS = ['keywords', 'record', 'scope', 'sortBy', 'currentPage', 'pageSize', 'cols'];

/** `params` is the grid's own query string, so the address is the search route plus that string. */
export function savedQueryUrl(query: SavedQuery): string {
  return `/search?${query.params}`;
}

function recordOf(params: URLSearchParams): RecordType {
  const record = params.get('record') ?? '';
  return record in RECORD_LABELS ? (record as RecordType) : DEFAULT_RECORD;
}

/** One line of what the query narrows to: record type, keywords, how many filters. */
export function savedQuerySummary(query: SavedQuery): string {
  const params = new URLSearchParams(query.params);
  const parts = [RECORD_LABELS[recordOf(params)]];

  const keywords = params.get('keywords') ?? '';
  if (keywords) parts.push(`“${keywords}”`);

  const filters = [...params.keys()].filter(
    (key) => !RESERVED_PARAMS.includes(key) && (params.get(key) ?? '') !== '',
  ).length;
  if (filters) parts.push(`${filters} filter${filters === 1 ? '' : 's'}`);

  return parts.join(' · ');
}
