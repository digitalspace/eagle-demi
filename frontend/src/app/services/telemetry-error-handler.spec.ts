import { TestBed } from '@angular/core/testing';
import { TelemetryErrorHandler } from './telemetry-error-handler';
import { TelemetryService } from './telemetry.service';

describe('TelemetryErrorHandler', () => {
  let handler: TelemetryErrorHandler;
  let telemetry: jasmine.SpyObj<TelemetryService>;

  beforeEach(() => {
    telemetry = jasmine.createSpyObj<TelemetryService>('TelemetryService', ['trackException', 'init']);
    TestBed.configureTestingModule({
      providers: [TelemetryErrorHandler, { provide: TelemetryService, useValue: telemetry }]
    });
    spyOn(console, 'error');
    handler = TestBed.inject(TelemetryErrorHandler);
  });

  it('reports the error once and still logs it', () => {
    const error = new Error('boom');
    handler.handleError(error);
    expect(telemetry.trackException).toHaveBeenCalledOnceWith(error);
    expect(console.error).toHaveBeenCalledWith(error);
  });
});
