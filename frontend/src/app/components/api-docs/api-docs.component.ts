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

  /** The spec is a route under the API base: /api/api-docs works relative and absolute. */
  openSwagger() {
    const basePath = this.configService.config.API_PATH || '/api';
    window.open(`${basePath}/api-docs`, '_blank');
  }
}
