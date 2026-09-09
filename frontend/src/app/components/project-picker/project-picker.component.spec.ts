import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { MAX_ROWS, ProjectPickerComponent } from './project-picker.component';
import { ProjectSummaryService } from '../../services/project-summary.service';
import { RegistryStateService } from '../../services/registry-state.service';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Angular's control-flow blocks leave newlines between text nodes; a reader sees one line. */
const squash = (text: string | null | undefined) => (text || '').replace(/\s+/g, ' ').trim();

const PROJECTS = [
  { id: 272, name: 'Site C Clean Energy Project', region: 'Peace', proponent: { name: 'BC Hydro' } },
  { id: 111, name: 'Ajax Mine', region: 'Thompson-Okanagan', currentPhaseName: '5d3f6c7eda7a384218296035' },
  { id: 333, name: 'Coastal GasLink Pipeline', proponent: { name: 'TC Energy' } },
  { id: 444, name: 'ajax Creek Diversion' }
];

const PHASE_ROWS = [{ id: '5d3f6c7eda7a384218296035', name: 'Post Decision - Construction' }];

describe('ProjectPickerComponent', () => {
  let fixture: ComponentFixture<ProjectPickerComponent>;

  /** One stub for both reads the screen makes: the project page and the `List` name lookup. */
  function routeFetch(handler: (url: string) => Response) {
    spyOn(window, 'fetch').and.callFake((input: RequestInfo | URL) =>
      Promise.resolve(handler(String(input)))
    );
  }

  const projectSearch = (rows: unknown[], total?: number) =>
    json([{ count: rows.length, meta: [{ searchResultsTotal: total ?? rows.length }], searchResults: rows }]);

  /** The default: every project answered, phase names resolvable. */
  function stubHappyPath(rows: unknown[] = PROJECTS, total?: number) {
    routeFetch(url => {
      if (url.includes('dataset=List')) return json([{ searchResults: PHASE_ROWS, count: PHASE_ROWS.length }]);
      if (url.includes('dataset=Project')) return projectSearch(rows, total);
      return json([{ searchResults: [], count: 0 }]);
    });
  }

  async function render(): Promise<HTMLElement> {
    await TestBed.configureTestingModule({
      imports: [ProjectPickerComponent],
      providers: [provideHttpClient(withXhr()), provideHttpClientTesting(), provideRouter([])]
    }).compileComponents();

    const registry = TestBed.inject(RegistryStateService);
    await registry.authReady;
    // Root-provided and cached for the session, so a previous spec's list would otherwise stand.
    const service = TestBed.inject(ProjectSummaryService);
    service.projects.set(null);
    service.projectsTotal.set(null);
    service.projectsError.set('');
    service.lists.set(null);

    fixture = TestBed.createComponent(ProjectPickerComponent);
    fixture.detectChanges();
    // Reading a Response body is itself asynchronous, so one turn lands the fetch and not the JSON.
    for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  const type = (el: HTMLElement, text: string) => {
    const input = el.querySelector<HTMLInputElement>('#pp-search')!;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };

  const names = (el: HTMLElement) =>
    Array.from(el.querySelectorAll('.pp-result__name')).map(row => squash(row.textContent));

  it('lists every project alphabetically with a count', async () => {
    stubHappyPath();

    const el = await render();

    expect(names(el)).toEqual([
      'ajax Creek Diversion',
      'Ajax Mine',
      'Coastal GasLink Pipeline',
      'Site C Clean Energy Project'
    ]);
    expect(squash(el.querySelector('.pp-count')?.textContent)).toBe('4 projects');
  });

  it('filters on a case-insensitive substring of the name', async () => {
    stubHappyPath();

    const el = await render();

    type(el, 'AJAX');

    expect(names(el)).toEqual(['ajax Creek Diversion', 'Ajax Mine']);
    expect(squash(el.querySelector('.pp-count')?.textContent)).toBe('2 projects');
  });

  // Substring, not prefix: a reader who remembers "GasLink" should not have to know it is Coastal.
  it('matches inside the name, and says so when nothing does', async () => {
    stubHappyPath();

    const el = await render();

    type(el, 'gaslink');
    expect(names(el)).toEqual(['Coastal GasLink Pipeline']);
    expect(squash(el.querySelector('.pp-count')?.textContent)).toBe('1 project');

    type(el, 'quarry');
    expect(names(el)).toEqual([]);
    expect(squash(el.querySelector('[role="status"]')?.textContent)).toBe('No project matches “quarry”.');
  });

  it('links each result at that project’s summary', async () => {
    stubHappyPath();

    const el = await render();

    const hrefs = Array.from(el.querySelectorAll<HTMLAnchorElement>('.pp-result'))
      .map(link => link.getAttribute('href'));

    expect(hrefs).toEqual(['/projects/444', '/projects/111', '/projects/333', '/projects/272']);
  });

  it('shows the region or proponent and the resolved phase under the name', async () => {
    stubHappyPath();

    const el = await render();

    const metas = Array.from(el.querySelectorAll('.pp-result')).map(row =>
      squash(row.querySelector('.pp-result__meta')?.textContent));

    // Ajax Mine's phase is a `List` id on the record; it must render as the name behind it.
    expect(metas).toEqual(['', 'Thompson-Okanagan · Post Decision - Construction', 'TC Energy', 'Peace']);
  });

  it('draws only the first page of matches and says how many there are', async () => {
    const many = Array.from({ length: MAX_ROWS + 12 }, (_, i) => ({
      id: 1000 + i,
      name: `Project ${String(i).padStart(3, '0')}`
    }));
    stubHappyPath(many);

    const el = await render();

    expect(el.querySelectorAll('.pp-result').length).toBe(MAX_ROWS);
    expect(squash(el.querySelector('.pp-count')?.textContent))
      .toBe(`${many.length} projects · showing the first ${MAX_ROWS}`);
  });

  // The read is one page, so the loaded list is not always the registry. Never claim it is.
  it('says how much of the registry the one read covered', async () => {
    stubHappyPath(PROJECTS, 900);

    const el = await render();

    expect(squash(el.querySelector('.pp-count')?.textContent)).toBe('4 projects · 4 of 900 loaded');
  });

  it('says no projects are visible rather than a blank-query non-match, when the registry is empty', async () => {
    stubHappyPath([], 0);

    const el = await render();

    expect(squash(el.querySelector('.pp-count')?.textContent)).toBe('0 projects');
    expect(squash(el.querySelector('[role="status"]')?.textContent)).toBe('No projects are visible to you.');
  });

  it('reports a failed read instead of showing an empty registry', async () => {
    routeFetch(url =>
      url.includes('dataset=Project') ? json({ error: 'boom' }, 500) : json([{ searchResults: [] }]));

    const el = await render();

    expect(squash(el.querySelector('[role="alert"]')?.textContent)).toContain('could not be loaded');
    expect(el.querySelectorAll('.pp-result').length).toBe(0);
  });

  it('shows the skeleton while the project read is in flight, then clears it', async () => {
    let resolveProjects!: (res: Response) => void;
    spyOn(window, 'fetch').and.callFake((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('dataset=Project')) return new Promise<Response>(resolve => { resolveProjects = resolve; });
      return Promise.resolve(json([{ searchResults: [], count: 0 }]));
    });

    await TestBed.configureTestingModule({
      imports: [ProjectPickerComponent],
      providers: [provideHttpClient(withXhr()), provideHttpClientTesting(), provideRouter([])]
    }).compileComponents();
    const registry = TestBed.inject(RegistryStateService);
    await registry.authReady;
    const service = TestBed.inject(ProjectSummaryService);
    service.projects.set(null);
    service.projectsTotal.set(null);
    service.projectsError.set('');
    service.lists.set(null);

    fixture = TestBed.createComponent(ProjectPickerComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelectorAll('.skeleton').length).toBeGreaterThan(0);
    expect(el.querySelector('[aria-busy]')?.getAttribute('aria-busy')).toBe('true');

    resolveProjects(projectSearch([{ id: 1, name: 'Only Project' }]));
    for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(el.querySelectorAll('.skeleton').length).toBe(0);
    expect(names(el)).toEqual(['Only Project']);
  });

  it('focuses the search box and walks into the results with the arrow keys', async () => {
    stubHappyPath();

    const el = await render();
    const input = el.querySelector<HTMLInputElement>('#pp-search')!;

    expect(document.activeElement).toBe(input);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    fixture.detectChanges();
    const rows = el.querySelectorAll<HTMLAnchorElement>('.pp-result');
    expect(document.activeElement).toBe(rows[0]);

    rows[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(rows[1]);

    rows[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(rows[0]);

    rows[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(input);
  });
});
