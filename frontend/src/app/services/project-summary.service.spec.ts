import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ProjectSummaryService, joinLabels, resolveListLabel } from './project-summary.service';
import { RegistryStateService } from './registry-state.service';

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

/** Real ids and names from the `lists` container, kind `List`. */
const PHASE_ID = '5d3f6c7eda7a384218296035';
const PHASE_NAME = 'Post Decision - Construction';
const CEAA_ID = '5e27937a749c83437054f200';
const CEAA_NAME = 'Joint Review Panel';

const LIST_ROWS = [
  { id: PHASE_ID, _id: PHASE_ID, name: PHASE_NAME, type: 'projectPhase' },
  { id: CEAA_ID, _id: CEAA_ID, name: CEAA_NAME, type: 'ceaaInvolvement' }
];

const LISTS = new Map([[PHASE_ID, PHASE_NAME], [CEAA_ID, CEAA_NAME]]);

describe('resolveListLabel', () => {
  it('turns a stored List ObjectId into its name', () => {
    expect(resolveListLabel(PHASE_ID, LISTS))
      .toEqual({ text: PHASE_NAME, unresolved: false, pending: false });
  });

  it('passes a value that is already a name through untouched', () => {
    // The mock fixture and any record the backfill resolved arrive this way.
    expect(resolveListLabel('Certificate Issued', LISTS))
      .toEqual({ text: 'Certificate Issued', unresolved: false, pending: false });
  });

  it('reads the name off the {_id, name} shape without consulting the lookup', () => {
    expect(resolveListLabel({ _id: PHASE_ID, name: 'Pre-Application' }, new Map()))
      .toEqual({ text: 'Pre-Application', unresolved: false, pending: false });
  });

  it('falls back to the id, marked unresolved, when no row matches', () => {
    const unknown = '000000000000000000000000';
    expect(resolveListLabel(unknown, LISTS))
      .toEqual({ text: unknown, unresolved: true, pending: false });
  });

  it('withholds an id while the lookup is still in flight', () => {
    // Empty text, not the id: showing it and swapping a moment later is the flash this avoids.
    expect(resolveListLabel(PHASE_ID, null))
      .toEqual({ text: '', unresolved: false, pending: true });
  });

  it('does not stall a plain name on a lookup that has not landed', () => {
    expect(resolveListLabel('Joint Review Panel', null))
      .toEqual({ text: 'Joint Review Panel', unresolved: false, pending: false });
  });

  it('answers empty for a field the record does not carry', () => {
    expect(resolveListLabel(null, LISTS)).toEqual({ text: '', unresolved: false, pending: false });
  });
});

describe('joinLabels', () => {
  it('renders the resolved names as one line', () => {
    expect(joinLabels([CEAA_ID, PHASE_ID], LISTS, ' · ').text).toBe(`${CEAA_NAME} · ${PHASE_NAME}`);
  });

  it('names every id it could not place in the title, and nothing when all resolved', () => {
    const line = joinLabels(['000000000000000000000000', PHASE_ID], LISTS, ', ');
    expect(line.title).toBe('Not in the registry’s list of names: 000000000000000000000000');
    expect(joinLabels([PHASE_ID], LISTS, ', ').title).toBe('');
  });

  it('drops an absent field rather than leaving a stray separator', () => {
    expect(joinLabels([undefined, PHASE_ID], LISTS, ' · ').text).toBe(PHASE_NAME);
  });
});

describe('ProjectSummaryService list lookup', () => {
  let service: ProjectSummaryService;
  let fetchSpy: jasmine.Spy;

  /** URLs the service asked for, so a cache claim is checked against calls that did not happen. */
  const listUrls = () =>
    fetchSpy.calls.allArgs().map(args => String(args[0])).filter(url => url.includes('dataset=List'));

  beforeEach(async () => {
    // Stub before injection: RegistryStateService's constructor issues its own requests.
    fetchSpy = spyOn(window, 'fetch').and.callFake((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('dataset=List')) {
        return Promise.resolve(jsonResponse([{ searchResults: LIST_ROWS, count: LIST_ROWS.length }]));
      }
      if (url.includes('/summary')) return Promise.resolve(jsonResponse({ error: 'not found' }, 404));
      return Promise.resolve(jsonResponse([]));
    });

    TestBed.configureTestingModule({
      providers: [provideHttpClient(withXhr()), provideHttpClientTesting(), RegistryStateService, ProjectSummaryService]
    });
    await TestBed.inject(RegistryStateService).authReady;
    service = TestBed.inject(ProjectSummaryService);
    // Root-provided, so a previous spec's load would otherwise stand.
    service.loadedId.set(null);
    service.organizations.set(null);
    service.lists.set(null);
    fetchSpy.calls.reset();
  });

  async function settle(turns = 5) {
    for (let i = 0; i < turns; i++) await new Promise(resolve => setTimeout(resolve, 0));
  }

  it('reads every List row in one page and indexes it by id', async () => {
    service.load('272');
    await settle();

    expect(listUrls()).toEqual(['/api/search?dataset=List&pageSize=1000']);
    expect(service.resolveLabel(PHASE_ID).text).toBe(PHASE_NAME);
  });

  it('reuses the table for the next project instead of reading it again', async () => {
    service.load('272');
    await settle();
    fetchSpy.calls.reset();

    service.load('402');
    await settle();

    expect(listUrls()).toEqual([]);
    expect(service.resolveLabel(CEAA_ID).text).toBe(CEAA_NAME);
  });

  it('drops a row with no name so the id shows with its explanation instead of a blank', async () => {
    fetchSpy.and.resolveTo(jsonResponse([{ searchResults: [{ id: PHASE_ID, name: '' }], count: 1 }]));

    service.load('272');
    await settle();

    expect(service.resolveLabel(PHASE_ID)).toEqual({ text: PHASE_ID, unresolved: true, pending: false });
  });

  it('settles on an empty table when the lookup fails, rather than leaving labels pending', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ error: 'unavailable' }, 502));

    service.load('272');
    await settle();

    expect(service.lists()).toEqual(new Map());
    expect(service.resolveLabel(PHASE_ID).pending).toBeFalse();
  });
});

describe('ProjectSummaryService project list', () => {
  let service: ProjectSummaryService;
  let registry: RegistryStateService;
  let fetchSpy: jasmine.Spy;

  /** URLs the service asked for, so a reuse claim is checked against calls that did not happen. */
  const projectUrls = () =>
    fetchSpy.calls.allArgs().map(args => String(args[0])).filter(url => url.includes('dataset=Project'));

  beforeEach(async () => {
    fetchSpy = spyOn(window, 'fetch').and.callFake((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('dataset=List')) return Promise.resolve(jsonResponse([{ searchResults: [], count: 0 }]));
      return Promise.resolve(jsonResponse([{ searchResults: [], count: 0 }]));
    });

    TestBed.configureTestingModule({
      providers: [provideHttpClient(withXhr()), provideHttpClientTesting(), RegistryStateService, ProjectSummaryService]
    });
    registry = TestBed.inject(RegistryStateService);
    await registry.authReady;
    service = TestBed.inject(ProjectSummaryService);
    service.projects.set(null);
    service.projectsLoading.set(false);
    service.projectsError.set('');
    service.projectsTotal.set(null);
    fetchSpy.calls.reset();
  });

  async function settle(turns = 5) {
    for (let i = 0; i < turns; i++) await new Promise(resolve => setTimeout(resolve, 0));
  }

  it('drops a search row with no name or no id', async () => {
    fetchSpy.and.callFake((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('dataset=Project')) {
        return Promise.resolve(jsonResponse([{
          count: 3,
          searchResults: [
            { id: '1', name: 'Named Project' },
            { id: '', name: 'No id, cannot be searched for' },
            { id: '2', name: '' }
          ]
        }]));
      }
      return Promise.resolve(jsonResponse([{ searchResults: [], count: 0 }]));
    });

    await service.loadProjects();
    await settle();

    expect(service.projects()?.map(p => p.name)).toEqual(['Named Project']);
  });

  it('reuses the registry\'s already-loaded, unfiltered project list instead of asking again', async () => {
    registry.projects.set([
      { id: '9', name: 'Reused Project', gatingState: 'admitted', region: 'Peace', proponent: 'BC Hydro' }
    ]);
    registry.projectMatchCount.set(1);

    await service.loadProjects();
    await settle();

    expect(projectUrls()).toEqual([]);
    expect(service.projects()).toEqual([
      { id: '9', name: 'Reused Project', region: 'Peace', proponent: 'BC Hydro', currentPhaseName: null }
    ]);
  });

  it('reads its own page when the registry list is narrowed by a live keyword search', async () => {
    // A filtered registry() is a subset, not the picker's whole list — reusing it here would
    // silently hide every project the global search box does not currently match.
    registry.projects.set([{ id: '9', name: 'Filtered match', gatingState: 'admitted' }]);
    registry.searchQuery.set('pipeline');
    fetchSpy.and.callFake((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('dataset=Project')) {
        return Promise.resolve(jsonResponse([{ searchResults: [{ id: '9', name: 'Full list' }], count: 1 }]));
      }
      return Promise.resolve(jsonResponse([{ searchResults: [], count: 0 }]));
    });

    await service.loadProjects();
    await settle();

    expect(projectUrls().length).toBe(1);
    expect(service.projects()?.map(p => p.name)).toEqual(['Full list']);
  });

  it('reads its own page when the registry has not loaded a project list yet', async () => {
    fetchSpy.and.callFake((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('dataset=Project')) {
        return Promise.resolve(jsonResponse([{ searchResults: [{ id: '9', name: 'Own read' }], count: 1 }]));
      }
      return Promise.resolve(jsonResponse([{ searchResults: [], count: 0 }]));
    });

    await service.loadProjects();
    await settle();

    expect(projectUrls().length).toBe(1);
    expect(service.projects()?.map(p => p.name)).toEqual(['Own read']);
  });
});
