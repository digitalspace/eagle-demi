import { Component, inject } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive, Router } from '@angular/router';
import { RegistryStateService } from './services/registry-state.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent {
  service = inject(RegistryStateService);
  router = inject(Router);

  login() {
    this.service.loginKeycloak();
  }

  openSwagger() {
    const basePath = this.service.config.API_PATH || '/api';
    const url = basePath === '/api' ? '/api-docs' : basePath.replace(/\/api$/, '/api-docs');
    window.open(url, '_blank');
  }

  logout() {
    this.service.logout();
  }
}
