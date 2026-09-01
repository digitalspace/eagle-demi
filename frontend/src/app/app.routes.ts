import { Route, Router, Routes } from '@angular/router';
import { inject } from '@angular/core';
import { ConfigService } from './services/config.service';
import { readPrefs } from './shell/prefs';

// No route guard: AppComponent renders the sign-in screen instead of the router outlet until
// isStaff() is true, so every route is gated once, in one place.
const screen = (path: string, loadComponent: Route['loadComponent']): Route =>
  ({ path, loadComponent });

export const routes: Routes = [
  screen('workspace', () => import('./components/my-workspace/my-workspace.component').then(m => m.MyWorkspaceComponent)),
  screen('map', () => import('./components/map-explorer/map-explorer.component').then(m => m.MapExplorerComponent)),
  screen('index', () => import('./components/index-search/index-search.component').then(m => m.IndexSearchComponent)),
  screen('content', () => import('./components/content-search/content-search.component').then(m => m.ContentSearchComponent)),
  screen('summary', () => import('./components/summarizer/summarizer.component').then(m => m.SummarizerComponent)),
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
  { path: 'search', redirectTo: 'index', pathMatch: 'full' },
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
