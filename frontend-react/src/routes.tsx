import { redirect, type RouteObject } from 'react-router';
import { config } from './config';
import { readPrefs } from './shell/prefs';
import { Shell } from './shell/Shell';

// No route guard: App renders the sign-in screen instead of the router until isStaff is true, so
// every route is gated once, in one place.
const screen = (path: string, key: string): RouteObject => ({
  path,
  lazy: async () => {
    const { ScreenPending } = await import('./shell/ScreenPending');
    return { Component: () => <ScreenPending screenKey={key} /> };
  },
});

/** Angular's UrlTree serializer percent-encodes; URLSearchParams would write a space as `+`. */
const queryString = (params: Record<string, string>): string =>
  Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');

/**
 * The index and document content screens are one page now. `q` was the words they searched for,
 * so it arrives as `keywords`; the rest of their screen state has no equivalent on the grid.
 */
const legacySearch = (path: string, queryParams: Record<string, string>): RouteObject => ({
  path,
  loader: ({ request }) => {
    const keywords = new URL(request.url).searchParams.get('q') ?? '';
    const query = queryString(keywords ? { ...queryParams, keywords } : queryParams);
    return redirect(query ? `/search?${query}` : '/search');
  },
});

/** Where the spec lives when API_PATH cannot be trusted to name a place on this origin. */
const API_DOCS_FALLBACK = '/api/api-docs';

/**
 * API_PATH is remote-settable (`/api/config` merges last), so it is treated as untrusted input
 * here: only a same-origin path is navigated to, never an absolute URL and never `//host`.
 */
export function apiDocsTarget(apiPath: unknown): string {
  if (typeof apiPath !== 'string' || !apiPath) return API_DOCS_FALLBACK;
  const target = `${apiPath}/api-docs`;
  if (!target.startsWith('/') || target.startsWith('//')) return API_DOCS_FALLBACK;
  try {
    if (new URL(target, window.location.origin).origin !== window.location.origin) {
      return API_DOCS_FALLBACK;
    }
  } catch {
    return API_DOCS_FALLBACK;
  }
  return target;
}

export const routes: RouteObject[] = [
  {
    path: '/',
    Component: Shell,
    children: [
      { path: 'workspace', lazy: async () => ({ Component: (await import('./screens/Workspace')).Workspace }) },
      screen('map', 'map'),
      screen('search', 'search'),
      legacySearch('index', {}),
      legacySearch('content', { record: 'documents', scope: 'inside' }),
      screen('summary', 'summary'),
      { path: 'projects', lazy: async () => ({ Component: (await import('./screens/ProjectPicker')).ProjectPicker }) },
      screen('projects/:id', 'project'),
      { path: 'notify', lazy: async () => ({ Component: (await import('./screens/Notify')).Notify }) },
      { path: 'links', lazy: async () => ({ Component: (await import('./screens/ShortLinks')).ShortLinks }) },
      { path: 'rbac', lazy: async () => ({ Component: (await import('./screens/AccessModel')).AccessModel }) },
      // '/api' is the API proxy path locally, so the screen lives at /developers.
      { path: 'developers', lazy: async () => ({ Component: (await import('./screens/ApiDocs')).ApiDocs }) },
      { path: 'keys', lazy: async () => ({ Component: (await import('./screens/ApiKeys')).ApiKeys }) },
      { path: 'sessions', lazy: async () => ({ Component: (await import('./screens/Sessions')).Sessions }) },
      // The spec is a route under the API base; typing /api-docs here would land on the SPA
      // catch-all, so bounce to the API path, which works relative (via the edge) and absolute.
      {
        path: 'api-docs',
        loader: () => {
          window.location.replace(apiDocsTarget(config().API_PATH));
          return null;
        },
      },
      // The profile screen was folded into My account; old links and bookmarks still resolve.
      { path: 'profile', loader: () => redirect('/workspace') },
      {
        // Redirect target follows the saved "default landing screen" preference (My account screen).
        // readPrefs() already validates the saved key against SCREENS and falls back to 'map'.
        index: true,
        loader: () => redirect(`/${readPrefs().landing}`),
      },
      { path: '*', loader: () => redirect('/map') },
    ],
  },
];
