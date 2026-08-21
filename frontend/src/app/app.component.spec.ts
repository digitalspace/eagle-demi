import { TestBed } from '@angular/core/testing';
import { AppComponent } from './app.component';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { routes } from './app.routes';

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
});
