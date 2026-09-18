import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { RegistryStateService } from '../../../services/registry-state.service';
import { UserdataService, type SavedQuery } from '../../../services/userdata.service';
import { GridToolbarComponent } from './grid-toolbar.component';

const jsonResponse = (payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const SAVED: SavedQuery = {
  slug: 'reports-2024',
  name: 'Reports 2024',
  params: 'record=documents&type=Report',
  savedAt: '2026-09-01T00:00:00.000Z',
};

/** The first element matching, or a failure that names what was missing. */
function pick<T extends Element>(page: HTMLElement, selector: string): T {
  const found = page.querySelector<T>(selector);
  if (!found) throw new Error(`No ${selector} on the page`);
  return found;
}

function buttonNamed(page: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(page.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
    button.textContent?.trim().startsWith(label),
  );
  if (!found) throw new Error(`No "${label}" button on the page`);
  return found;
}

describe('GridToolbarComponent', () => {
  let harness: RouterTestingHarness;
  let fetchSpy: jasmine.Spy;
  let userdata: UserdataService;

  /** The write, the reload it chains, and the render of what they left behind. */
  const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    harness.detectChanges();
  };

  async function mount(url: string): Promise<HTMLElement> {
    // Stub before injection: RegistryStateService's constructor issues its own requests.
    fetchSpy = spyOn(window, 'fetch').and.callFake(() =>
      Promise.resolve(jsonResponse({ prefs: null, lassos: [], queries: [SAVED] })),
    );

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
        provideRouter([{ path: 'search', component: GridToolbarComponent }]),
      ],
    });
    await TestBed.inject(RegistryStateService).authReady;

    harness = await RouterTestingHarness.create(url);
    userdata = TestBed.inject(UserdataService);
    userdata.queries.set([SAVED]);
    fetchSpy.calls.reset();
    harness.detectChanges();
    return harness.routeNativeElement as HTMLElement;
  }

  it('PUTs the query string in the address bar under the name that was typed', async () => {
    const page = await mount('/search?record=projects&keywords=mine');

    buttonNamed(page, 'Save this query').click();
    harness.detectChanges();
    const name = pick<HTMLInputElement>(page, '#saved-query-name');
    name.value = 'Mine';
    name.dispatchEvent(new Event('input'));
    harness.detectChanges();
    pick<HTMLFormElement>(page, '.saved-query__sheet').dispatchEvent(
      new Event('submit', { cancelable: true }),
    );
    await settle();

    const writes = fetchSpy.calls
      .allArgs()
      .filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
    expect(writes.length).toBe(1);
    expect(writes[0][0]).toBe('/api/me/queries');
    expect(JSON.parse((writes[0][1] as RequestInit).body as string)).toEqual({
      name: 'Mine',
      params: 'record=projects&keywords=mine',
    });
  });

  it('navigates to the address a saved query holds', async () => {
    const page = await mount('/search');
    const navigate = spyOn(TestBed.inject(Router), 'navigateByUrl').and.resolveTo(true);

    buttonNamed(page, 'Saved queries').click();
    harness.detectChanges();
    buttonNamed(page, 'Reports 2024').click();

    expect(navigate).toHaveBeenCalledOnceWith('/search?record=documents&type=Report');
  });

  it('DELETEs a saved query by its slug', async () => {
    const page = await mount('/search');

    buttonNamed(page, 'Saved queries').click();
    harness.detectChanges();
    pick<HTMLButtonElement>(page, '.saved-query__delete').click();
    await settle();

    const [url, init] = fetchSpy.calls.first().args as [string, RequestInit];
    expect(url).toBe('/api/me/queries/reports-2024');
    expect(init.method).toBe('DELETE');
  });

  it('says so when nothing has been saved', async () => {
    const page = await mount('/search');
    userdata.queries.set([]);

    buttonNamed(page, 'Saved queries').click();
    harness.detectChanges();

    expect(pick(page, '.saved-query__empty').textContent?.trim()).toBe('No saved queries yet');
  });
});
