import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { ConfigService } from '../../services/config.service';
import { SEARCH_DEBOUNCE_MS, UnifiedSearchService } from '../../search/unified-search.service';
import { NARROW_QUERY } from './display-grid/display-grid.component';
import { UnifiedSearchComponent } from './unified-search.component';

const jsonResponse = (payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const emptyEnvelope = [{ searchResults: [], meta: [{ searchResultsTotal: 0 }] }];

/** One document, so the grid draws a table rather than its empty state. */
const documentEnvelope = [
  {
    searchResults: [
      { _id: 'doc-1', displayName: 'Fisheries assessment', datePosted: '2024-03-01', type: 'Application' },
    ],
    meta: [{ searchResultsTotal: 1 }],
  },
];

/** The advanced panel's fields, in the order it draws them. A date field names its format in a
 *  nested span, so only the label's own text is read. */
const panelLabels = (page: HTMLElement): string[] =>
  Array.from(
    page.querySelectorAll<HTMLElement>('.display-grid__panel .display-grid__panel-label'),
  ).map((label) => label.firstChild?.textContent?.trim() ?? '');

/**
 * The grid's own reads. `&fuzzy=` is what tells them apart from the registry service's, which the
 * shell issues for the older screens and which carry no such parameter.
 */
const searchUrls = (spy: jasmine.Spy): string[] =>
  spy.calls
    .allArgs()
    .map(([url]) => String(url))
    .filter((url) => url.includes('dataset=Project') && url.includes('&fuzzy='));

/** Runtime config lives on the window, which is where `ConfigService` reads it from. */
const env = window as unknown as Record<string, unknown>;

describe('UnifiedSearchComponent', () => {
  let harness: RouterTestingHarness;
  let router: Router;
  let fetchSpy: jasmine.Spy;
  const envBefore = env['__env'];

  afterEach(() => {
    env['__env'] = envBefore;
  });

  /** A render, then the debounce the service waits out, then the render of what it answered. */
  const settle = async (): Promise<void> => {
    harness.detectChanges();
    await harness.fixture.whenStable();
    harness.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 100));
    await harness.fixture.whenStable();
    harness.detectChanges();
  };

  interface MountOptions {
    /** Turns on the `CONTENT_SEARCH` key the scope switch is gated on. */
    contentSearch?: boolean;
    /** What every read answers with. The default is an empty result set. */
    payload?: unknown;
    /** Reports the phone breakpoint as matching, which is what puts the grid in card mode. */
    narrow?: boolean;
  }

  async function mount(url: string, options: MountOptions = {}): Promise<HTMLElement> {
    const answer = options.payload ?? emptyEnvelope;
    fetchSpy = spyOn(window, 'fetch').and.callFake(() => Promise.resolve(jsonResponse(answer)));

    if (options.narrow) {
      const real = window.matchMedia.bind(window);
      spyOn(window, 'matchMedia').and.callFake((query: string) =>
        query === NARROW_QUERY
          ? ({
              matches: true,
              media: query,
              addEventListener: () => {},
              removeEventListener: () => {},
            } as unknown as MediaQueryList)
          : real(query),
      );
    }

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
        provideRouter([{ path: 'search', component: UnifiedSearchComponent }]),
      ],
    });

    env['__env'] = options.contentSearch ? { CONTENT_SEARCH: true } : {};
    const configured = TestBed.inject(ConfigService).init();
    // The public config document the service reads at boot. The window carries the flag here, so
    // the document answers with nothing to add.
    TestBed.inject(HttpTestingController).expectOne('/api/config/public').flush({});
    await configured;

    harness = await RouterTestingHarness.create();
    router = TestBed.inject(Router);
    await harness.navigateByUrl(url, UnifiedSearchComponent);
    await settle();
    return harness.routeNativeElement as HTMLElement;
  }

  function tab(page: HTMLElement, label: string): HTMLButtonElement {
    const pills = Array.from(page.querySelectorAll<HTMLButtonElement>('.unified-search__pill'));
    const found = pills.find((pill) => pill.textContent?.trim().startsWith(label));
    if (!found) throw new Error(`No ${label} tab on the page`);
    return found;
  }

  it('keeps the keyword and drops the filters and sort when the record type changes', async () => {
    const page = await mount(
      '/search?record=projects&keywords=mine&sortBy=%2Bname&region=Peace&cols=type',
    );

    tab(page, 'Documents').click();
    await settle();

    expect(router.url).toBe('/search?keywords=mine&sortBy=-datePosted');
  });

  it('badges each tab with the count the endpoint answered', async () => {
    const page = await mount('/search?record=projects&keywords=mine');
    const counts = TestBed.inject(UnifiedSearchService);
    await counts.loadCounts('mine');
    harness.detectChanges();

    // The stub answers an empty envelope, so no count is known and no badge is drawn.
    expect(page.querySelectorAll('.unified-search__pill-count').length).toBe(0);

    counts.counts.set({ projects: 12, documents: 3400, activities: null, notifications: null });
    harness.detectChanges();

    const badges = Array.from(
      page.querySelectorAll<HTMLElement>('.unified-search__pill-count'),
    ).map((badge) => badge.textContent?.trim());
    expect(badges).toEqual(['12', '3,400']);
  });

  it('offers one tab per record type, each badged with its own count', async () => {
    const page = await mount('/search?record=projects&keywords=mine');
    TestBed.inject(UnifiedSearchService).counts.set({
      projects: 12,
      documents: 3400,
      activities: 87,
      notifications: 5,
    });
    harness.detectChanges();

    const pills = Array.from(page.querySelectorAll<HTMLButtonElement>('.unified-search__pill'));
    expect(pills.map((pill) => pill.firstChild?.textContent?.trim())).toEqual([
      'Projects',
      'Documents',
      'Activities & updates',
      'Project notifications',
    ]);
    const badges = Array.from(
      page.querySelectorAll<HTMLElement>('.unified-search__pill-count'),
    ).map((badge) => badge.textContent?.trim());
    expect(badges).toEqual(['12', '3,400', '87', '5']);
  });

  it('hides the scope switch where the environment cannot search inside the documents', async () => {
    const page = await mount('/search?record=documents&keywords=mine');

    expect(page.querySelector('.unified-search__scope')).toBeNull();
  });

  it('offers the scope switch on the documents tab where content search is on', async () => {
    const page = await mount('/search?record=documents&keywords=mine', { contentSearch: true });

    const options = Array.from(
      page.querySelectorAll<HTMLButtonElement>('.unified-search__scope-option'),
    );
    expect(options.map((option) => option.textContent?.trim())).toEqual([
      'Names & details',
      'Inside documents',
    ]);
    expect(options[0].getAttribute('aria-pressed')).toBe('true');

    options[1].click();
    await settle();

    expect(router.url).toBe('/search?keywords=mine&scope=inside&sortBy=-matches');
  });

  it('carries no scope switch on a tab other than documents', async () => {
    const page = await mount('/search?record=projects&keywords=mine', { contentSearch: true });

    expect(page.querySelector('.unified-search__scope')).toBeNull();
  });

  it('asks the chunk dataset and draws its passages inside the documents', async () => {
    const page = await mount('/search?record=documents&scope=inside&keywords=fish', {
      contentSearch: true,
      payload: [
        {
          searchResults: [
            {
              documentId: 'doc-1',
              documentName: 'Fisheries assessment',
              datePosted: '2024-03-01',
              documentType: 'Application',
              matchCount: 2,
              passages: [
                { text: 'the fish habitat report', pageNumber: 12, pageNumbered: true },
                { text: 'downstream fish counts', pageNumbered: false },
              ],
            },
          ],
          meta: [{ searchResultsTotal: 1 }],
        },
      ],
    });

    const asked = fetchSpy.calls
      .allArgs()
      .map(([url]) => String(url))
      .filter((url) => url.includes('dataset=DocumentChunk'));
    expect(asked.length).toBe(1);
    expect(asked[0]).toContain('sortBy=-score');

    expect(page.querySelector('.display-grid__table')).toBeNull();
    expect(page.querySelector('.display-grid__passage-count')?.textContent?.trim()).toBe(
      '2 matching passages',
    );
    const locators = Array.from(
      page.querySelectorAll<HTMLElement>('.display-grid__passage-locator'),
    ).map((locator) => locator.textContent?.trim());
    expect(locators).toEqual(['Page 12', 'Passage 2']);

    // The chunk index cannot sort, so the one order it has is the only choice offered.
    const sorts = Array.from(page.querySelectorAll<HTMLOptionElement>('.display-grid__sort-select option'));
    expect(sorts.map((option) => option.textContent?.trim())).toEqual(['Most matches']);
  });

  it('prompts rather than asking the chunk dataset without a keyword', async () => {
    const page = await mount('/search?record=documents&scope=inside', { contentSearch: true });

    expect(page.querySelector('.unified-search__prompt-title')?.textContent?.trim()).toBe(
      'Search inside the documents',
    );
    const asked = fetchSpy.calls
      .allArgs()
      .map(([url]) => String(url))
      .filter((url) => url.includes('dataset=DocumentChunk'));
    expect(asked).toEqual([]);
  });

  it('issues no search for a keyword below the two-character floor', async () => {
    const page = await mount('/search?record=projects');
    const before = searchUrls(fetchSpy).length;
    expect(before).withContext('the first view asks once').toBe(1);

    const box = page.querySelector<HTMLInputElement>('.unified-search__input');
    if (!box) throw new Error('No keyword box on the page');
    box.value = 'm';
    box.dispatchEvent(new Event('input'));
    await settle();

    expect(searchUrls(fetchSpy).length).toBe(before);

    box.value = 'mi';
    box.dispatchEvent(new Event('input'));
    await settle();

    expect(searchUrls(fetchSpy).length).toBe(before + 1);
    expect(searchUrls(fetchSpy)[before]).toContain('keywords=mi');
  });

  it('gives the notifications panel every column filter, the layout having no row for them', async () => {
    const page = await mount('/search?record=notifications');

    expect(panelLabels(page)).toEqual([
      'Project type',
      'Region',
      'Public comment period',
      'Notification decision',
    ]);
  });

  it('appends the activities column filter after the record\u2019s own panel fields', async () => {
    const page = await mount('/search?record=activities');

    expect(panelLabels(page)).toEqual([
      'Posted from',
      'Posted to',
      'Documents attached',
      'Kind',
    ]);
  });

  it('leaves the document column filters in the filter row on a wide screen', async () => {
    const page = await mount('/search?record=documents', { payload: documentEnvelope });

    expect(page.querySelector('.display-grid__filter-row')).not.toBeNull();
    expect(panelLabels(page)).toEqual([
      'Posted from',
      'Posted to',
      'Legislation',
      'Featured documents',
    ]);
  });

  it('moves the document column filters into the panel in card mode', async () => {
    const page = await mount('/search?record=documents', {
      payload: documentEnvelope,
      narrow: true,
    });

    expect(page.querySelector('.display-grid__filter-row')).toBeNull();
    // A year column is not absorbed: the panel already carries the posted-date range.
    expect(panelLabels(page)).toEqual([
      'Posted from',
      'Posted to',
      'Legislation',
      'Featured documents',
      'Name',
      'Document type',
      'Milestone',
      'Project phase',
      'Author',
    ]);
  });

  it('counts a merged column filter in the More filters badge', async () => {
    const page = await mount('/search?record=notifications&region=Peace');

    expect(page.querySelector('.display-grid__badge')?.textContent?.trim()).toBe('1');
  });
});
