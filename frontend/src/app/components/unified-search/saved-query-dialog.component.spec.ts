import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RegistryStateService } from '../../services/registry-state.service';
import { SavedQueryDialogComponent } from './saved-query-dialog.component';

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('SavedQueryDialogComponent', () => {
  let fixture: ComponentFixture<SavedQueryDialogComponent>;
  let page: HTMLElement;
  let fetchSpy: jasmine.Spy;

  /** Waits on the write itself rather than on a fixed number of ticks, then renders the result. */
  const settle = async (): Promise<void> => {
    for (let tick = 0; tick < 20 && fixture.componentInstance.saving(); tick++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    fixture.detectChanges();
  };

  function pick<T extends Element>(selector: string): T {
    const found = page.querySelector<T>(selector);
    if (!found) throw new Error(`No ${selector} in the dialog`);
    return found;
  }

  /** Opens the dialog off a button the reader could have pressed, and types `name`. */
  function fill(name: string): void {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    fixture.componentInstance.open(opener, 'record=projects');
    fixture.detectChanges();
    const field = pick<HTMLInputElement>('#saved-query-name');
    field.value = name;
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  function submit(): void {
    pick<HTMLFormElement>('.saved-query__sheet').dispatchEvent(
      new Event('submit', { cancelable: true }),
    );
  }

  beforeEach(async () => {
    // Stub before injection: RegistryStateService's constructor issues its own requests.
    fetchSpy = spyOn(window, 'fetch').and.callFake(() =>
      Promise.resolve(jsonResponse({ prefs: null, lassos: [], queries: [] })),
    );

    TestBed.configureTestingModule({
      providers: [provideHttpClient(withXhr()), provideHttpClientTesting()],
    });
    await TestBed.inject(RegistryStateService).authReady;

    fixture = TestBed.createComponent(SavedQueryDialogComponent);
    fixture.detectChanges();
    page = fixture.nativeElement as HTMLElement;
    fetchSpy.calls.reset();
  });

  it('sends nothing for a name past the eighty-character ceiling', async () => {
    fill('n'.repeat(81));

    submit();
    await settle();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows what the API refused and stays open', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ error: 'at most 50 saved queries per user' }, 400));

    fill('One too many');
    submit();
    await settle();

    expect(pick('.saved-query__error').textContent?.trim()).toBe(
      'at most 50 saved queries per user',
    );
    expect(pick<HTMLDialogElement>('dialog').open).toBeTrue();
  });
});
