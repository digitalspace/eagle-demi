import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AppConfig, ConfigService } from './config.service';

const setEnv = (env: AppConfig): void => {
  (window as unknown as { __env?: AppConfig }).__env = env;
};

describe('ConfigService', () => {
  let service: ConfigService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), ConfigService]
    });
    service = TestBed.inject(ConfigService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    delete (window as unknown as { __env?: AppConfig }).__env;
    http.verify();
  });

  it('reads both config documents once and takes CONTENT_SEARCH from the public one', async () => {
    setEnv({ configEndpoint: true, API_PATH: '/api' });

    const ready = service.init();
    http.expectOne('/api/config/public').flush({ CONTENT_SEARCH: true });
    http.expectOne('/api/config').flush({ ENVIRONMENT: 'test' });
    await ready;

    expect(service.get('CONTENT_SEARCH')).toBeTrue();
    expect(service.get('ENVIRONMENT')).toBe('test');
  });

  it('lets the admin config and window.__env outrank a clashing public key', async () => {
    setEnv({ configEndpoint: true, API_PATH: '/api', BANNER_COLOUR: 'blue' });

    const ready = service.init();
    http.expectOne('/api/config/public').flush({ BANNER_COLOUR: 'gold', ENVIRONMENT: 'public' });
    http.expectOne('/api/config').flush({ ENVIRONMENT: 'admin' });
    await ready;

    expect(service.get('BANNER_COLOUR')).toBe('blue');
    expect(service.get('ENVIRONMENT')).toBe('admin');
  });

  it('still reads the public document when the admin config endpoint is off', async () => {
    setEnv({ configEndpoint: false, API_PATH: '/api' });

    const ready = service.init();
    http.expectOne('/api/config/public').flush({ CONTENT_SEARCH: true });
    http.expectNone('/api/config');
    await ready;

    expect(service.get('CONTENT_SEARCH')).toBeTrue();
  });

  it('keeps window.__env when neither document answers', async () => {
    spyOn(console, 'warn');
    setEnv({ configEndpoint: true, API_PATH: '/api', ENVIRONMENT: 'local' });

    const ready = service.init();
    http.expectOne('/api/config/public').flush('down', { status: 503, statusText: 'Service Unavailable' });
    http.expectOne('/api/config').flush('down', { status: 503, statusText: 'Service Unavailable' });
    await ready;

    expect(service.get('ENVIRONMENT')).toBe('local');
    expect(service.get('CONTENT_SEARCH')).toBeUndefined();
  });
});
