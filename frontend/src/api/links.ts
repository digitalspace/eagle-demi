import { useQuery } from '@tanstack/react-query';
import { api, jsonBody } from './client';

/** `GET /links` row shape — src/controllers/nosql/link.js `present()`. */
export interface ShortLink {
  id: string;
  url: string;
  note: string | null;
  shortUrl: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string | null;
  /** Hidden from other users' lists. `/s/:code` still redirects for anyone holding the URL. */
  personal: boolean;
  /** Set when a project holds the code; the API then refuses repoint and delete here. */
  projectId?: string;
  /** `current` is the project's code, `legacy` one it used before. */
  projectRole?: 'current' | 'legacy';
}

/** Lowercased both sides: the API stores `createdBy` lowercased, the token claim is not. */
export function isMine(link: ShortLink, username: string): boolean {
  return !!username && (link.createdBy || '').toLowerCase() === username.toLowerCase();
}

/** Shared by the short-links screen and the workspace panel, so both read one cache entry. */
export const LINKS_QUERY = ['links'];

export const listLinks = (): Promise<ShortLink[]> => api<ShortLink[]>('/links');

export function useLinks(enabled = true) {
  return useQuery({ queryKey: LINKS_QUERY, enabled, queryFn: listLinks });
}

/** `code` blank means the API generates one. */
export const createLink = (url: string, note: string, code: string, personal: boolean): Promise<ShortLink> =>
  api<ShortLink>('/links', jsonBody({ url, note: note || undefined, code: code || undefined, personal }));

export const repointLink = (code: string, url: string): Promise<ShortLink> =>
  api<ShortLink>(`/links/${encodeURIComponent(code)}`, jsonBody({ url }, 'PUT'));

export const removeLink = (code: string): Promise<void> =>
  api<void>(`/links/${encodeURIComponent(code)}`, { method: 'DELETE' });
