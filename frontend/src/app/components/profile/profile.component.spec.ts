import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ProfileComponent } from './profile.component';
import { RegistryStateService } from '../../services/registry-state.service';
import { UserdataService } from '../../services/userdata.service';
import { PREFS_KEY } from '../../shell/prefs';

describe('ProfileComponent', () => {
  let fixture: ComponentFixture<ProfileComponent>;
  let registry: RegistryStateService;
  let userdata: UserdataService;

  beforeEach(async () => {
    localStorage.clear();
    // RegistryStateService's constructor kicks off I/O — see registry-state.service.spec.ts.
    spyOn(window, 'fetch').and.callFake(() =>
      Promise.resolve(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    );

    await TestBed.configureTestingModule({
      imports: [ProfileComponent],
      providers: [provideHttpClient(withXhr()), provideHttpClientTesting()]
    }).compileComponents();

    registry = TestBed.inject(RegistryStateService);
    await registry.authReady;
    userdata = TestBed.inject(UserdataService);
    spyOn(userdata, 'loadMyData').and.resolveTo();
    fixture = TestBed.createComponent(ProfileComponent);
  });

  it('writes a preference change to BOTH localStorage and the API', async () => {
    const putPrefs = spyOn(userdata, 'putPrefs').and.resolveTo(true);
    registry.isAuthenticated.set(true);
    fixture.detectChanges();

    fixture.componentInstance.setLanding({ target: { value: 'index' } } as unknown as Event);

    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toEqual({ landing: 'index', perPage: 6 });
    expect(putPrefs).toHaveBeenCalledWith({ landing: 'index', perPage: 6 });
  });

  it('does not call the API for an anonymous visitor', () => {
    const putPrefs = spyOn(userdata, 'putPrefs').and.resolveTo(true);
    registry.isAuthenticated.set(false);
    fixture.detectChanges();

    fixture.componentInstance.setPerPage({ target: { value: '24' } } as unknown as Event);

    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!).perPage).toBe(24);
    expect(putPrefs).not.toHaveBeenCalled();
  });

  it('lists the saved map areas with a delete control', () => {
    registry.isAuthenticated.set(true);
    userdata.lassos.set([
      { slug: 'peace-valley', name: 'Peace Valley', ring: [[-121, 56], [-120, 56], [-120.5, 56.5]], updatedAt: '2026-08-30T00:00:00.000Z' }
    ]);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Saved map areas');
    expect(el.textContent).toContain('Peace Valley');

    const remove = spyOn(userdata, 'deleteLasso').and.resolveTo(true);
    const button = Array.from(el.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Delete');
    button!.click();

    expect(remove).toHaveBeenCalledWith('peace-valley');
  });
});
