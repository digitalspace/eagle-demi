import { TestBed } from '@angular/core/testing';
import { AppComponent } from './app.component';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { routes } from './app.routes';
import { ConfigService } from './services/config.service';

describe('AppComponent', () => {
  beforeEach(async () => {
    // AppComponent injects RegistryStateService (app.component.ts:14), whose constructor kicks off
    // I/O: initKeycloak() -> authSettled() -> loadData(). Unstubbed, that issued a real request,
    // karma answered 404, and the rejection settled after this spec had finished — which jasmine 7
    // reports as a run-level ERROR. See registry-state.service.spec.ts for the full note.
    spyOn(window, 'fetch').and.callFake(() =>
      Promise.resolve(new Response(JSON.stringify([{ searchResults: [] }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }))
    );

    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideRouter(routes),
        provideHttpClient(withXhr()),
        provideHttpClientTesting()
      ]
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  // The API mounts /api-docs in dev and test only (src/app.js), so in prod the link opened a tab
  // on a 404. The environment arrives through /api/config, which ConfigService merges into
  // window.__env — set here and re-read, so this drives the real config path, not the getter.
  describe('the Swagger link', () => {
    const swaggerButton = (fixture: any) =>
      Array.from(fixture.nativeElement.querySelectorAll('button.nav-tab'))
        .find((b: any) => b.textContent.includes('Swagger'));

    const renderWith = async (env?: string) => {
      (window as any)['__env'] = env === undefined ? {} : { ENVIRONMENT: env };
      await TestBed.inject(ConfigService).init();
      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();
      return fixture;
    };

    afterEach(() => { delete (window as any)['__env']; });

    it('is shown in dev and test', async () => {
      for (const env of ['dev', 'test']) {
        expect(swaggerButton(await renderWith(env))).toBeTruthy();
      }
    });

    it('is hidden in prod and when the environment is unknown', async () => {
      for (const env of ['prod', undefined]) {
        expect(swaggerButton(await renderWith(env))).toBeFalsy();
      }
    });
  });
});
