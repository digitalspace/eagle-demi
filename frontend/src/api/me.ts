import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { READ_TIMEOUT_MS, api, jsonBody } from './client';
import { writePrefs, type Prefs } from '../shell/prefs';
import { useSession } from '../session/session';

/** `GET /me/data` lasso row — src/controllers/nosql/userdata.js `presentLasso()`. */
export interface SavedLasso {
  slug: string;
  name: string;
  ring: number[][];
  updatedAt: string;
}

/** `GET /me/data` saved-query row. `params` replays the search at `/search?<params>`. */
export interface SavedQuery {
  slug: string;
  name: string;
  params: string;
  savedAt: string;
}

export interface MyData {
  prefs: Prefs | null;
  lassos: SavedLasso[];
  queries: SavedQuery[];
}

/** The only characters `PUT /me/queries` accepts in `params`; the rest must arrive encoded. */
const PARAMS_UNSAFE = /[^A-Za-z0-9_.%&=+,:*-]/gu;

/** Budget for `GET /me/data`; a hung API must not hold the screens open. */
export const MY_DATA_TIMEOUT_MS = READ_TIMEOUT_MS;

export const MY_DATA_KEY = ['me', 'data'];

/** Strips a leading `?` and percent-encodes what the API would refuse. */
export function toQueryParams(search: string): string {
  return search.replace(/^\?/, '').replace(PARAMS_UNSAFE, (char) => encodeURIComponent(char));
}

/**
 * Saved areas and preferences held server-side. The server copy wins: localStorage is the cache
 * that keeps the app working offline and before this answers, not the record. A failed read leaves
 * the browser's copy alone.
 */
export function useMyData() {
  const { authenticated } = useSession();

  return useQuery({
    queryKey: MY_DATA_KEY,
    enabled: authenticated,
    queryFn: async (): Promise<MyData> => {
      const data = await api<MyData>('/me/data', { timeoutMs: MY_DATA_TIMEOUT_MS });
      const loaded = { prefs: data.prefs ?? null, lassos: data.lassos ?? [], queries: data.queries ?? [] };
      if (loaded.prefs) writePrefs(loaded.prefs);
      return loaded;
    },
  });
}

/** Every write reloads `/me/data`: the API derives the slug, so the caller cannot predict the row. */
function useMyDataWrite<T>(request: (input: T) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: () => client.invalidateQueries({ queryKey: MY_DATA_KEY }),
  });
}

/** Upserts by the slug the API derives from `name`. */
export function useSaveLasso() {
  return useMyDataWrite(({ name, ring }: { name: string; ring: number[][] }) =>
    api('/me/lassos', jsonBody({ name, ring }, 'PUT')),
  );
}

export function useDeleteLasso() {
  return useMyDataWrite((slug: string) =>
    api(`/me/lassos/${encodeURIComponent(slug)}`, { method: 'DELETE' }),
  );
}

/** `search` is the current query string; any key beyond `name` and `params` is a 400. */
export function useSaveQuery() {
  return useMyDataWrite(({ name, search }: { name: string; search: string }) =>
    api('/me/queries', jsonBody({ name, params: toQueryParams(search) }, 'PUT')),
  );
}

export function useDeleteQuery() {
  return useMyDataWrite((slug: string) =>
    api(`/me/queries/${encodeURIComponent(slug)}`, { method: 'DELETE' }),
  );
}

/**
 * Preferences go to this browser first and to the account after, so a choice holds even when the
 * API call fails. An anonymous visitor has no account row to write, so only localStorage is used.
 */
export function useSavePrefs() {
  const { authenticated } = useSession();
  const client = useQueryClient();

  return useMutation({
    mutationFn: async (prefs: Prefs): Promise<Prefs> => {
      writePrefs(prefs);
      if (!authenticated) return prefs;
      // No reload: the caller already holds the values, and localStorage is written above.
      return api<Prefs>('/me/prefs', jsonBody(prefs, 'PUT'));
    },
    onSuccess: (prefs) =>
      client.setQueryData(MY_DATA_KEY, (data: MyData | undefined) =>
        data ? { ...data, prefs } : data,
      ),
  });
}
