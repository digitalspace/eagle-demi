import { Routes } from '@angular/router';
import { MapExplorerComponent } from './components/map-explorer/map-explorer.component';
import { DeepSearchComponent } from './components/deep-search/deep-search.component';
import { DocumentIntakeComponent } from './components/document-intake/document-intake.component';
import { authGuard } from './guards/auth.guard';

export const routes: Routes = [
  { path: 'map', component: MapExplorerComponent },
  { path: 'search', component: DeepSearchComponent },
  { path: 'intake', component: DocumentIntakeComponent, canActivate: [authGuard] },
  { path: '', redirectTo: 'map', pathMatch: 'full' },
  { path: '**', redirectTo: 'map' }
];
export const appRoutes = routes;
