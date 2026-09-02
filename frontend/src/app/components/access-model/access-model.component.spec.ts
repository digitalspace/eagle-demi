import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { AccessModelComponent, SimulateResponse } from './access-model.component';
import { RegistryStateService } from '../../services/registry-state.service';

/** An answer shaped exactly like `POST /api/access/simulate` returns one. */
const answer = (over: Partial<SimulateResponse> = {}): SimulateResponse => ({
  roles: ['public', 'staff'],
  level: 2,
  tier: 'public',
  privileged: false,
  staffUi: true,
  rows: {
    1: { readable: true, via: 'team' },
    2: { readable: true, via: 'role' },
    3: { readable: true, via: 'role' },
    4: { readable: true, via: 'role' }
  },
  fields: {
    projects: [
      { field: 'name', defaultVis: 4, maxVis: 4, when: null, visible: true },
      { field: 'cacEmail', defaultVis: 2, maxVis: 4, when: 'cacPublished', visible: true },
      { field: 'read', defaultVis: 0, maxVis: 0, when: null, visible: false }
    ],
    documents: [
      { field: 'displayName', defaultVis: 4, maxVis: 4, when: null, visible: true },
      { field: 's3Key', defaultVis: 0, maxVis: 0, when: null, visible: false }
    ]
  },
  predicatesAssumedFalse: true,
  notes: { sealedCompartment: 'designed, not built (Phase 5)' },
  ...over
});

describe('AccessModelComponent', () => {
  let fixture: ComponentFixture<AccessModelComponent>;
  let registry: RegistryStateService;
  let fetchSpy: jasmine.Spy;

  /** The bodies POSTed to the simulator, oldest first. */
  const simulatePosts = () => fetchSpy.calls.allArgs()
    .filter(([url]) => String(url).includes('/access/simulate'))
    .map(([, init]) => init as RequestInit);

  beforeEach(async () => {
    // Debounce shortened so the specs wait milliseconds rather than the interactive 150.
    AccessModelComponent.debounceMs = 5;

    // Installed BEFORE the service is constructed, so its fetch interceptor wraps this spy and the
    // Authorization header it attaches is visible in the recorded arguments.
    fetchSpy = spyOn(window, 'fetch').and.callFake((url: RequestInfo | URL) =>
      Promise.resolve(new Response(
        String(url).includes('/access/simulate') ? JSON.stringify(answer()) : '[]',
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ))
    );

    await TestBed.configureTestingModule({
      imports: [AccessModelComponent],
      providers: [provideHttpClient(withXhr()), provideHttpClientTesting()]
    }).compileComponents();

    registry = TestBed.inject(RegistryStateService);
    await registry.authReady;
    (registry as unknown as { keycloak: unknown }).keycloak = { token: 'test-token' };
    registry.isAuthenticated.set(true);
    fixture = TestBed.createComponent(AccessModelComponent);
  });

  /** Renders, then lets the debounce fire and the answer land. */
  async function settle(): Promise<HTMLElement> {
    fixture.detectChanges();
    await new Promise(resolve => setTimeout(resolve, 30));
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('sends the described caller as the request body, omitting what was not asked for', async () => {
    const component = fixture.componentInstance;
    component.roles.set({ public: true, staff: true });
    component.identityProvider.set('idir');
    component.teamsText.set('402, 111');
    component.scopeText.set('402');
    component.credentialOn.set(true);
    component.credentialIdsText.set('402');
    component.credentialLevels.set({ 2: true, 3: true });
    await settle();

    const posts = simulatePosts();
    expect(posts.length).toBeGreaterThan(0);
    const post = posts[posts.length - 1];
    expect(post.method).toBe('POST');
    expect(JSON.parse(post.body as string)).toEqual({
      roles: ['public', 'staff'],
      identityProvider: 'idir',
      teams: ['402', '111'],
      projectScope: ['402'],
      credential: { scope: { type: 'project', ids: ['402'] }, levels: [2, 3] }
    });
  });

  it('omits every optional key for a caller with nothing but the public floor', async () => {
    await settle();

    const post = simulatePosts()[0];
    expect(JSON.parse(post.body as string)).toEqual({ roles: ['public'] });
  });

  it('carries the caller‘s bearer token, which the simulator now requires', async () => {
    await settle();

    const headers = simulatePosts()[0].headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-token');
  });

  it('asks nothing and offers a sign-in message when there is no session', async () => {
    registry.isAuthenticated.set(false);
    const el = await settle();

    expect(simulatePosts().length).toBe(0);
    expect(el.textContent).toContain('Sign in to run the simulator');
    expect(el.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('collapses rapid changes into one request', async () => {
    const component = fixture.componentInstance;
    fixture.detectChanges();
    component.teamsText.set('4');
    fixture.detectChanges();
    component.teamsText.set('40');
    fixture.detectChanges();
    component.teamsText.set('402');
    await settle();

    expect(simulatePosts().length).toBe(1);
    expect(JSON.parse(simulatePosts()[0].body as string).teams).toEqual(['402']);
  });

  it('renders each ladder row with the arm that got the caller there', async () => {
    const el = await settle();

    const rows = Array.from(el.querySelectorAll('.attention-row')).map(r => r.textContent || '');
    const level1 = rows.find(r => r.includes('Level 1 — Team only')) || '';
    const level2 = rows.find(r => r.includes('Level 2 — All EAO')) || '';
    expect(level1).toContain('via team');
    expect(level1).toContain('Readable');
    expect(level2).toContain('via role');
  });

  it('marks an unreachable level withheld and shows no arm', async () => {
    fetchSpy.and.callFake((url: RequestInfo | URL) => Promise.resolve(new Response(
      String(url).includes('/access/simulate')
        ? JSON.stringify(answer({ rows: { 1: { readable: false, via: null }, 2: { readable: false, via: null }, 3: { readable: false, via: null }, 4: { readable: true, via: 'role' } } }))
        : '[]',
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )));
    const el = await settle();

    const level1 = Array.from(el.querySelectorAll('.attention-row'))
      .map(r => r.textContent || '').find(r => r.includes('Level 1 — Team only')) || '';
    expect(level1).toContain('Withheld');
    expect(level1).not.toContain('via');
  });

  it('renders the field catalogs and hides the plumbing keys until asked', async () => {
    const el = await settle();

    const fieldCells = () => Array.from(el.querySelectorAll('tbody code')).map(c => c.textContent);
    expect(fieldCells()).toContain('name');
    expect(fieldCells()).toContain('cacEmail');
    expect(fieldCells()).not.toContain('read');
    expect(fieldCells()).not.toContain('s3Key');
    expect(el.textContent).toContain('1 plumbing key hidden');

    fixture.componentInstance.showPlumbing.set(true);
    fixture.detectChanges();
    expect(fieldCells()).toContain('read');
    expect(fieldCells()).toContain('s3Key');
  });

  it('shows a field‘s predicate and its dial ceiling', async () => {
    const el = await settle();

    const row = Array.from(el.querySelectorAll('tbody tr'))
      .find(r => (r.textContent || '').includes('cacEmail'));
    const cells = Array.from(row!.querySelectorAll('td')).map(c => (c.textContent || '').trim());
    expect(cells).toEqual(['cacEmail', '2', '4', 'cacPublished', 'Returned']);
  });

  it('renders the sealed compartment as a note from the response, never a control', async () => {
    const el = await settle();

    const sealed = Array.from(el.querySelectorAll('.attention-row'))
      .find(r => (r.textContent || '').includes('Level 0 — sealed compartment'));
    expect(sealed!.textContent).toContain('designed, not built (Phase 5)');
    expect(sealed!.querySelector('input')).toBeNull();
  });

  it('drops the answer and reports the engine‘s own refusal', async () => {
    fetchSpy.and.callFake((url: RequestInfo | URL) => Promise.resolve(new Response(
      String(url).includes('/access/simulate')
        ? JSON.stringify({ error: 'scope.ids must be a non-empty array' })
        : '[]',
      { status: String(url).includes('/access/simulate') ? 400 : 200, headers: { 'Content-Type': 'application/json' } }
    )));
    const el = await settle();

    expect(el.textContent).toContain('scope.ids must be a non-empty array');
    expect(fixture.componentInstance.result()).toBeNull();
  });

  it('never asks /me itself — the service already holds the real caller', async () => {
    // The service asks /me once while it settles authReady; only what the component does counts.
    fetchSpy.calls.reset();
    await settle();

    expect(fetchSpy.calls.allArgs().filter(([url]) => String(url).endsWith('/me')).length).toBe(0);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('You, right now: level');
  });
});
