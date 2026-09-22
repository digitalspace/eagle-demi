/**
 * How a saved query reads and where it opens. Shared by the grid toolbar and the account screen,
 * so both name a query the same way and replay it through the same address.
 */

import type { SavedQuery } from '../api/me';
import { parseGridParams } from './grid-url';
import { recordConfig } from './record-types';

/** `params` is the grid's own query string, so the address is the search route plus that string. */
export function savedQueryUrl(query: SavedQuery): string {
  return `/search?${query.params}`;
}

/** One line of what the query narrows to: record type, keywords, how many filters. */
export function savedQuerySummary(query: SavedQuery): string {
  const state = parseGridParams(new URLSearchParams(query.params));
  const parts = [recordConfig(state.record).label];
  if (state.keywords) parts.push(`“${state.keywords}”`);
  const filters = Object.keys(state.filters).length;
  if (filters) parts.push(`${filters} filter${filters === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** The record type a saved query lands on, for its row in the menu. */
export function savedQueryRecordLabel(query: SavedQuery): string {
  return recordConfig(parseGridParams(new URLSearchParams(query.params)).record).label;
}
