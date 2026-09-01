import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ShortLinksComponent } from './short-links.component';
import { LinksService, ShortLink } from '../../services/links.service';
import { RegistryStateService } from '../../services/registry-state.service';

const link = (id: string, createdBy: string, personal = false): ShortLink => ({
  id,
  url: `https://demi.gov.bc.ca/projects/${id}`,
  note: null,
  shortUrl: `https://demi.gov.bc.ca/s/${id}`,
  createdAt: '2026-08-24T00:00:00.000Z',
  createdBy,
  updatedAt: null,
  personal
});

describe('ShortLinksComponent grouping', () => {
  let fixture: ComponentFixture<ShortLinksComponent>;
  let registry: RegistryStateService;
  let links: LinksService;

  beforeEach(async () => {
    // RegistryStateService's constructor kicks off I/O — see registry-state.service.spec.ts.
    spyOn(window, 'fetch').and.callFake(() =>
      Promise.resolve(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    );

    await TestBed.configureTestingModule({
      imports: [ShortLinksComponent],
      providers: [provideHttpClient(withXhr()), provideHttpClientTesting()]
    }).compileComponents();

    registry = TestBed.inject(RegistryStateService);
    await registry.authReady;
    links = TestBed.inject(LinksService);
    fixture = TestBed.createComponent(ShortLinksComponent);
  });

  /** Signs in as J.Okafor, lets ngOnInit's load settle, then plants the rows under test. */
  async function withLinks(rows: ShortLink[]): Promise<HTMLElement> {
    (registry as unknown as { keycloak: unknown }).keycloak = { tokenParsed: { preferred_username: 'J.Okafor' } };
    registry.isAuthenticated.set(true);
    fixture.detectChanges();
    await new Promise(resolve => setTimeout(resolve, 0));
    links.links.set(rows);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('puts my links above the shared ones, matching the username case-insensitively', async () => {
    // The API lowercases createdBy; the token claim is not guaranteed to be, so a case-sensitive
    // comparison would file every one of the caller's own links under "Shared links".
    const el = await withLinks([link('shared-a', 'r.singh'), link('mine-a', 'j.okafor')]);

    expect(fixture.componentInstance.linkGroups().map(g => g.title)).toEqual(['My links', 'Shared links']);
    const rows = Array.from(el.querySelectorAll('tbody tr')).map(r => r.textContent || '');
    expect(rows[0]).toContain('My links');
    expect(rows[1]).toContain('mine-a');
    expect(rows[2]).toContain('Shared links');
    expect(rows[3]).toContain('shared-a');
  });

  it('badges a personal link and leaves a shared one unbadged', async () => {
    const el = await withLinks([link('mine-p', 'j.okafor', true), link('shared-a', 'r.singh')]);

    const cells = Array.from(el.querySelectorAll('tbody td'));
    const personalCell = cells.find(c => (c.textContent || '').includes('mine-p'));
    const sharedCell = cells.find(c => (c.textContent || '').includes('shared-a'));
    expect(personalCell!.textContent).toContain('Personal');
    expect(sharedCell!.textContent).not.toContain('Personal');
  });

  it('shows only Shared links when none of them are mine', async () => {
    await withLinks([link('shared-a', 'r.singh')]);

    expect(fixture.componentInstance.linkGroups().map(g => g.title)).toEqual(['Shared links']);
  });
});
