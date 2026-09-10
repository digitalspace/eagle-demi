import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { DocTypeSelectComponent } from './doc-type-select.component';
import { RegistryStateService } from '../../services/registry-state.service';

describe('DocTypeSelectComponent', () => {
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
      imports: [DocTypeSelectComponent],
      providers: [provideHttpClient(withXhr()), provideHttpClientTesting()]
    }).compileComponents();

    service = TestBed.inject(RegistryStateService);
  });

  /** The picker with the given options loaded, as either screen renders it. */
  const render = (label: string) => {
    service.docTypeOptions.set([
      { value: 'idletter', label: 'Amendment Package' },
      { value: 'id2018,id2002', label: 'Certificate Package' }
    ]);
    const fixture = TestBed.createComponent(DocTypeSelectComponent);
    fixture.componentRef.setInput('ariaLabel', label);
    fixture.detectChanges();
    return {
      fixture,
      select: (fixture.nativeElement as HTMLElement).querySelector('select') as HTMLSelectElement
    };
  };

  it('offers every loaded type under All types, named by the screen that renders it', () => {
    const { select } = render('Filter passages by document type');

    expect([...select.options].map(o => o.textContent?.trim()))
      .toEqual(['All types', 'Amendment Package', 'Certificate Package']);
    expect(select.getAttribute('aria-label')).toBe('Filter passages by document type');
  });

  it('narrows the search to the picked type, and back to all of them', () => {
    const setDocType = spyOn(service, 'setDocType');
    const { select } = render('Filter documents by type');

    select.value = 'id2018,id2002';
    select.dispatchEvent(new Event('change'));
    expect(setDocType).toHaveBeenCalledWith('id2018,id2002');

    select.value = '';
    select.dispatchEvent(new Event('change'));
    expect(setDocType).toHaveBeenCalledWith('');
  });

  it('shows the type already in force, so both screens agree on it', () => {
    service.selectedDocType.set('id2018,id2002');
    const { select } = render('Filter documents by type');

    expect(select.value).toBe('id2018,id2002');
  });
});
