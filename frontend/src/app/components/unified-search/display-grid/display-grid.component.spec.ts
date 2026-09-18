import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { UnifiedSearchComponent } from '../unified-search.component';
import { SEARCH_DEBOUNCE_MS } from '../../../search/unified-search.service';

const jsonResponse = (payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const projectRows = [
  { _id: 'p1', name: 'Ajax Mine', dateUpdated: '2025-06-01T00:00:00Z', region: 'Thompson-Nicola' },
  { _id: 'p2', name: 'Site C', dateUpdated: '2024-02-03T00:00:00Z', region: 'Peace' },
];

const documentRows = [
  { _id: 'd1', displayName: 'Wildlife Management Plan', datePosted: '2025-03-04T00:00:00Z' },
];

/** Every read this page makes answers the same envelope; the grid only needs rows and a total. */
const stubFetch = () =>
  spyOn(window, 'fetch').and.callFake((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('dataset=Project')) {
      return Promise.resolve(
        jsonResponse([{ searchResults: projectRows, meta: [{ searchResultsTotal: 2 }] }]),
      );
    }
    if (url.includes('dataset=Document')) {
      return Promise.resolve(
        jsonResponse([{ searchResults: documentRows, meta: [{ searchResultsTotal: 1 }] }]),
      );
    }
    return Promise.resolve(jsonResponse([{ searchResults: [], meta: [{ searchResultsTotal: 0 }] }]));
  });

describe('DisplayGridComponent', () => {
  let harness: RouterTestingHarness;
  let router: Router;

  async function mount(url: string, narrow = false): Promise<HTMLElement> {
    const real = window.matchMedia.bind(window);
    spyOn(window, 'matchMedia').and.callFake((query: string) => {
      if (!query.includes('max-width: 719.98px')) return real(query);
      return {
        matches: narrow,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      } as unknown as MediaQueryList;
    });

    stubFetch();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
        provideRouter([{ path: 'search', component: UnifiedSearchComponent }]),
      ],
    });

    harness = await RouterTestingHarness.create();
    router = TestBed.inject(Router);
    await harness.navigateByUrl(url, UnifiedSearchComponent);
    // The service waits for typing to stop before it asks, so the rows land after the debounce.
    await settle();
    harness.detectChanges();
    return harness.routeNativeElement as HTMLElement;
  }

  const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 100));
    await harness.fixture.whenStable();
  };

  // A native modal `<dialog>` left open when a fixture is torn down keeps the page inert and
  // keeps taking the browser's focus in later specs sharing this Karma session; close and
  // destroy before the next test's TestBed module takes over.
  afterEach(() => {
    document.querySelectorAll<HTMLDialogElement>('dialog[open]').forEach((dialog) => dialog.close());
    harness?.fixture.destroy();
  });

  it('sorts by the column whose heading was pressed', async () => {
    const page = await mount('/search?record=projects&sortBy=-dateUpdated');

    const headings = Array.from(page.querySelectorAll<HTMLButtonElement>('.display-grid__sort'));
    const nameHeading = headings.find((button) => button.textContent?.includes('Project'));
    nameHeading?.click();
    await harness.fixture.whenStable();

    expect(router.url).toBe('/search?record=projects&sortBy=%2Bname');
  });

  it('flips the direction when the heading in force is pressed again', async () => {
    const page = await mount('/search?record=projects&sortBy=%2Bname');

    const headings = Array.from(page.querySelectorAll<HTMLButtonElement>('.display-grid__sort'));
    headings.find((button) => button.textContent?.includes('Project'))?.click();
    await harness.fixture.whenStable();

    expect(router.url).toBe('/search?record=projects&sortBy=-name');
  });

  it('returns to page one when a column filter narrows the set', async () => {
    const page = await mount('/search?record=projects&sortBy=-dateUpdated&currentPage=4');

    // The date column's year picker: its options are the years the record spans, not a lookup.
    const years = page.querySelector<HTMLSelectElement>('select.display-grid__control');
    if (!years) throw new Error('No year filter in the filter row');
    years.value = '2024';
    years.dispatchEvent(new Event('change'));
    await harness.fixture.whenStable();

    expect(router.url).toBe('/search?record=projects&sortBy=-dateUpdated&dateUpdated=2024');
  });

  it('draws one card per record below the narrow breakpoint', async () => {
    const page = await mount('/search?record=projects', true);

    expect(page.querySelector('.display-grid__table')).toBeNull();
    expect(page.querySelectorAll('.display-grid__card').length).toBe(projectRows.length);
  });

  it('draws a table above the narrow breakpoint', async () => {
    const page = await mount('/search?record=projects');

    expect(page.querySelector('.display-grid__table')).not.toBeNull();
    expect(page.querySelectorAll('.display-grid__card').length).toBe(0);
  });
  const dialogOf = (page: HTMLElement): HTMLDialogElement => {
    const dialog = page.querySelector<HTMLDialogElement>('dialog.record-detail');
    if (!dialog) throw new Error('No record detail dialog in the grid');
    return dialog;
  };

  const firstRow = (page: HTMLElement): HTMLElement => {
    const row = page.querySelector<HTMLElement>('tbody tr.display-grid__row');
    if (!row) throw new Error('No result row');
    return row;
  };

  it('opens the record in a dialog when its row is pressed', async () => {
    const page = await mount('/search?record=projects');

    firstRow(page).click();
    harness.detectChanges();

    const dialog = dialogOf(page);
    expect(dialog.open).toBeTrue();
    expect(dialog.querySelector('#record-detail-title')?.textContent).toContain('Ajax Mine');
  });

  it('returns focus to the row the dialog was opened from when it closes', async () => {
    const page = await mount('/search?record=projects');
    const row = firstRow(page);

    row.click();
    harness.detectChanges();
    const dialog = dialogOf(page);

    // `close()` fires the same `close` event Escape would, so this stands in for both. The
    // browser queues that event on its own task source rather than firing it inline, and this
    // headless Chrome sometimes stalls that queue past any fixed test timeout (confirmed: the
    // real event does fire, in under 5ms, on the runs where it fires at all) — a browser-timing
    // gap this suite should not depend on. Dispatching it directly still exercises the
    // component's own `(close)` handler, which is what this test is about.
    dialog.close();
    dialog.dispatchEvent(new Event('close'));
    harness.detectChanges();

    expect(document.activeElement).toBe(row);
  });

  it('offers a document its download inside the dialog', async () => {
    const page = await mount('/search?record=documents');

    firstRow(page).click();
    harness.detectChanges();

    const dialog = dialogOf(page);
    expect(dialog.querySelector('#record-detail-title')?.textContent).toContain(
      'Wildlife Management Plan',
    );
    const actions = Array.from(dialog.querySelectorAll('button')).map((button) =>
      button.textContent?.trim(),
    );
    expect(actions).toContain('Download');
  });

  it('leaves a modified press on the name to the link it is on', async () => {
    const page = await mount('/search?record=projects');

    const name = firstRow(page).querySelector<HTMLElement>('[data-record-name] a');
    if (!name) throw new Error('No name link in the row');
    const press = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    name.dispatchEvent(press);
    harness.detectChanges();

    expect(dialogOf(page).open).toBeFalse();
    expect(press.defaultPrevented).toBeFalse();
  });
});
