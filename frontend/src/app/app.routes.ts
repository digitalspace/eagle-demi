import { Routes } from '@angular/router';
import { inject } from '@angular/core';
import { MapExplorerComponent } from './components/map-explorer/map-explorer.component';
import { DeepSearchComponent } from './components/deep-search/deep-search.component';
import { DocumentIntakeComponent } from './components/document-intake/document-intake.component';
import { SummarizerComponent } from './components/summarizer/summarizer.component';
import { authGuard } from './guards/auth.guard';
import { ConfigService } from './services/config.service';

export const routes: Routes = [
  { path: 'map', component: MapExplorerComponent },
  { path: 'search', component: DeepSearchComponent },
  // Deliberately UNGUARDED, unlike /intake. The component renders a sign-in explanation for
  // non-staff instead of redirecting, so the tool's existence and its gate are both visible.
  { path: 'summary', component: SummarizerComponent },
  { path: 'intake', component: DocumentIntakeComponent, canActivate: [authGuard] },
  // Swagger lives on the API host; this SPA is a static file server with a catch-all, so
  // people who type /api-docs here would silently land on the dashboard. Bounce them to the
  // right host, derived from config so it follows the environment.
  {
    path: 'api-docs',
    canActivate: [() => {
      const apiLocation = inject(ConfigService).config.API_LOCATION || '';
      window.location.replace(`${apiLocation.replace(/\/$/, '')}/api-docs/`);
      return false;
    }],
    children: []
  },
  { path: '', redirectTo: 'map', pathMatch: 'full' },
  { path: '**', redirectTo: 'map' }
];
export const appRoutes = routes;
