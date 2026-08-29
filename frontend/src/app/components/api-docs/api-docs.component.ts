import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ConfigService } from '../../services/config.service';

/** Environments that serve the Swagger UI. Anywhere else the route is not published. */
const SWAGGER_ENVIRONMENTS = ['dev', 'test'];

@Component({
  selector: 'app-api-docs',
  standalone: true,
  imports: [],
  templateUrl: './api-docs.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: []
})
export class ApiDocsComponent {
  private configService = inject(ConfigService);

  get swaggerAvailable(): boolean {
    return SWAGGER_ENVIRONMENTS.includes(String(this.configService.config.ENVIRONMENT || '').toLowerCase());
  }

  /** Swagger lives beside the API, not on this SPA's origin. */
  openSwagger() {
    const basePath = this.configService.config.API_PATH || '/api';
    const url = basePath === '/api' ? '/api-docs' : basePath.replace(/\/api$/, '/api-docs');
    window.open(url, '_blank');
  }
}
