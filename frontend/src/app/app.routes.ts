import { ActivatedRouteSnapshot, Route, Router, Routes } from '@angular/router';
import { inject } from '@angular/core';
import { ConfigService } from './services/config.service';
import { readPrefs } from './shell/prefs';

// No route guard: AppComponent renders the sign-in screen instead of the router outlet until
// isStaff() is true, so every route is gated once, in one place.
const screen = (path: string, loadComponent: Route['loadComponent']): Route =>
  ({ path, loadComponent });

/**
 * The index and document content screens are one page now. `q` was the words they searched for,
 * so it arrives as `keywords`; the rest of their screen state has no equivalent on the grid.
 */
const legacySearch = (path: string, queryParams: Record<string, string>): Route => ({
  path,
  canActivate: [(route: ActivatedRouteSnapshot) => {
    const keywords = String(route.queryParams['q'] ?? '');
    return inject(Router).createUrlTree(['/search'], {
      queryParams: keywords ? { ...queryParams, keywords } : queryParams
    });
  }],
  children: []
});

export const routes: Routes = [
  screen('workspace', () => import('./components/my-workspace/my-workspace.component').then(m => m.MyWorkspaceComponent)),
  screen('map', () => import('./components/map-explorer/map-explorer.component').then(m => m.MapExplorerComponent)),
  screen('search', () => import('./components/unified-search/unified-search.component').then(m => m.UnifiedSearchComponent)),
  legacySearch('index', {}),
  legacySearch('content', { record: 'documents', scope: 'inside' }),
  screen('summary', () => import('./components/summarizer/summarizer.component').then(m => m.SummarizerComponent)),
  screen('projects', () => import('./components/project-picker/project-picker.component').then(m => m.ProjectPickerComponent)),
  screen('projects/:id', () => import('./components/project-summary/project-summary.component').then(m => m.ProjectSummaryComponent)),
  screen('notify', () => import('./components/notify/notify.component').then(m => m.NotifyComponent)),
  screen('links', () => import('./components/short-links/short-links.component').then(m => m.ShortLinksComponent)),
  screen('rbac', () => import('./components/access-model/access-model.component').then(m => m.AccessModelComponent)),
  // '/api' is the API proxy path locally, so the screen lives at /developers.
  screen('developers', () => import('./components/api-docs/api-docs.component').then(m => m.ApiDocsComponent)),
  screen('keys', () => import('./components/api-keys/api-keys.component').then(m => m.ApiKeysComponent)),
  screen('sessions', () => import('./components/sessions/sessions.component').then(m => m.SessionsComponent)),
  // The spec is a route under the API base; typing /api-docs here would land on the SPA
  // catch-all, so bounce to the API path, which works relative (via the edge) and absolute.
  {
    path: 'api-docs',
    canActivate: [() => {
      const basePath = inject(ConfigService).config.API_PATH || '/api';
      window.location.replace(`${basePath}/api-docs`);
      return false;
    }],
    children: []
  },
  // The profile screen was folded into My account; old links and bookmarks still resolve.
  { path: 'profile', redirectTo: 'workspace', pathMatch: 'full' },
  {
    path: '',
    pathMatch: 'full',
    // Redirect target follows the saved "default landing screen" preference (My account screen).
    // readPrefs() already validates the saved key against SCREENS and falls back to 'map'.
    canActivate: [() => inject(Router).parseUrl(`/${readPrefs().landing}`)],
    children: []
  },
  { path: '**', redirectTo: 'map' }
];
export const appRoutes = routes;
