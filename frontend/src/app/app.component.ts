import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet, RouterLink, RouterLinkActive, Router } from '@angular/router';
import { RegistryStateService } from './services/registry-state.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent {
  service = inject(RegistryStateService);
  router = inject(Router);

  setDemoRole(role: 'public' | 'admin') {
    this.service.setDemoRole(role);
    if (role === 'public' && this.router.url === '/intake') {
      this.router.navigate(['/map']);
    }
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
