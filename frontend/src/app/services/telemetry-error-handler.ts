import { ErrorHandler, Injectable, inject } from '@angular/core';
import { TelemetryService } from './telemetry.service';

/** Angular swallows uncaught errors without a handler; this reports them and keeps the console trace. */
@Injectable({ providedIn: 'root' })
export class TelemetryErrorHandler implements ErrorHandler {
  private telemetry = inject(TelemetryService);

  handleError(error: unknown): void {
    this.telemetry.trackException(error);
    console.error(error);
  }
}
