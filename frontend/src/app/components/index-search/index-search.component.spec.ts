import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { IndexSearchComponent } from './index-search.component';
import { RegistryStateService } from '../../services/registry-state.service';

describe('IndexSearchComponent', () => {
  let service: RegistryStateService;

  beforeEach(async () => {
    // The service constructor fetches; see registry-state.service.spec.ts for why it is stubbed.
    spyOn(window, 'fetch').and.callFake(() =>
      Promise.resolve(new Response(JSON.stringify([{ searchResults: [] }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }))
    );

    await TestBed.configureTestingModule({
      imports: [IndexSearchComponent],
      providers: [provideHttpClient(withXhr()), provideHttpClientTesting()]
    }).compileComponents();

    service = TestBed.inject(RegistryStateService);
    service.docTypeOptions.set([{ value: 'id2018', label: 'Certificate Package' }]);
  });

  /** The screen on its Documents tab with a type picked, which is the only place the picker shows. */
  const renderNarrowed = () => {
    const fixture = TestBed.createComponent(IndexSearchComponent);
    fixture.componentInstance.setScope('documents');
    service.selectedDocType.set('id2018');
    fixture.detectChanges();
    return fixture;
  };

  it('renders the type picker on the Documents tab only', () => {
    const fixture = renderNarrowed();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('app-doc-type-select')).toBeTruthy();

    fixture.componentInstance.setScope('projects');
    fixture.detectChanges();
    expect(el.querySelector('app-doc-type-select')).toBeNull();
  });

  it('drops the type when the Projects tab takes the picker away', () => {
    // The summary line counts documents on both tabs, so a type left set on the tab that cannot
    // show it narrows that count with nothing on screen to say so, or to undo it.
    const fixture = renderNarrowed();

    fixture.componentInstance.setScope('projects');

    expect(service.selectedDocType()).toBe('');
  });
});
