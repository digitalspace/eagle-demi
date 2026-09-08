import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { ProjectSummaryComponent } from './project-summary.component';
import { ProjectSummaryService } from '../../services/project-summary.service';
import { RegistryStateService } from '../../services/registry-state.service';
import {
  MOCK_ORGANIZATIONS,
  MOCK_PROJECT_SUMMARY,
  MOCK_PROJECT_SUMMARY_FACTS
} from '../../mocks/mock-project-summary.data';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * The `dataset=List` leg. Every spec has to answer it: the page holds a label back until the
 * lookup lands, so an unanswered one leaves the header, the status and the phases blank.
 */
const listSearch = (rows: { id: string; name: string }[] = []) =>
  json([{ searchResults: rows, count: rows.length }]);

/** Angular's control-flow blocks leave newlines between text nodes; a reader sees one line. */
const squash = (text: string | null | undefined) => (text || '').replace(/\s+/g, ' ').trim();

describe('ProjectSummaryComponent', () => {
  let fixture: ComponentFixture<ProjectSummaryComponent>;
  let service: ProjectSummaryService;

  /**
   * One fetch stub for the whole page: the component fires three independent reads and each has
   * its own empty state, so a spec that stubbed only the one it cares about would leave the others
   * hanging on their loading sentinel and assert against a skeleton.
   */
  function routeFetch(handler: (url: string) => Response) {
    spyOn(window, 'fetch').and.callFake((input: RequestInfo | URL) =>
      Promise.resolve(handler(String(input)))
    );
  }

  async function render(): Promise<HTMLElement> {
    await TestBed.configureTestingModule({
      imports: [ProjectSummaryComponent],
      providers: [
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: '272' }) } } }
      ]
    }).compileComponents();

    const registry = TestBed.inject(RegistryStateService);
    await registry.authReady;
    service = TestBed.inject(ProjectSummaryService);
    // Root-provided and cached by project id, so a previous spec's load would otherwise stand.
    service.loadedId.set(null);
    service.organizations.set(null);
    service.lists.set(null);

    fixture = TestBed.createComponent(ProjectSummaryComponent);
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  /**
   * Several turns, not one: reading a real `Response` body is itself asynchronous, so a single
   * macrotask lands the 404 leg (which never parses a body) while the two that do are still
   * pending — which is how this spec first "proved" the page renders nothing.
   */
  async function settle(turns = 5) {
    for (let i = 0; i < turns; i++) await new Promise(resolve => setTimeout(resolve, 0));
  }

  it('renders the project facts when there is no generated summary', async () => {
    // 404 on the summary is the normal state of a project the generator has not run against. The
    // facts are the page; the AI blocks are the extra.
    routeFetch(url => {
      if (url.includes('/summary')) return json({ error: 'not found' }, 404);
      if (url.includes('dataset=List')) return listSearch();
      if (url.includes('/search?')) return json([{ searchResults: [], count: 0 }]);
      return json(MOCK_PROJECT_SUMMARY_FACTS);
    });

    const el = await render();

    expect(el.querySelector('.ps__title')?.textContent).toContain('Site C Clean Energy Project');
    expect(el.querySelector('.ps__meta')?.textContent).toContain('British Columbia Hydro');
    expect(el.querySelector('.ps-status__label')?.textContent).toContain('Certificate Issued');
    expect(el.querySelector('.ps-status')?.className).toContain('ps-status--success');
    expect(el.querySelector('.ps-note')?.textContent).toContain('No generated summary for this project yet');
    // Nothing generated may render without a record behind it.
    expect(el.querySelectorAll('.ps-card--action').length).toBe(0);
    expect(el.querySelector('.ps-footer')).toBeNull();
  });

  it('reads Eagle phase names as a sequence under the status, not as timeline rows', async () => {
    routeFetch(url => {
      if (url.includes('/summary')) return json({ error: 'not found' }, 404);
      if (url.includes('dataset=List')) return listSearch();
      if (url.includes('/search?')) return json([{ searchResults: [], count: 0 }]);
      return json(MOCK_PROJECT_SUMMARY_FACTS);
    });

    const el = await render();

    const phases = el.querySelector('.ps-status .ps__meta')!;
    expect(squash(phases.textContent))
      .toBe('Phases: Pre-Application › Application Review › Post Decision - Construction (current phase)');
    // The phase the project is in now is the one carrying weight.
    expect(phases.querySelector('strong')?.textContent).toBe('Post Decision - Construction');

    // Eagle's phase names have no dates, so they used to render as rows with an em dash for a date.
    const labels = Array.from(el.querySelectorAll('.ps-timeline__label')).map(row => squash(row.textContent));
    expect(labels).toEqual(['Certificate E14-01 issued']);
  });

  /**
   * The shape the real API returns. eagle-api's push resolves only `proponent`, `pins` and
   * `applicableRegulation`, so every other lookup field is a bare Eagle `List` ObjectId — which is
   * what this page rendered before the lookup existed.
   */
  const ID_FACTS = {
    ...MOCK_PROJECT_SUMMARY_FACTS,
    CEAAInvolvement: '5e27937a749c83437054f200',
    eacDecision: '5e27937a749c83437054f214',
    currentPhaseName: '5d3f6c7eda7a384218296035',
    phaseHistory: [
      '5d3f6c7eda7a38421829602f',
      '5d3f6c7eda7a384218296031',
      '5d3f6c7eda7a384218296035'
    ]
  };

  const ID_ROWS = [
    { id: '5e27937a749c83437054f200', name: 'Joint Review Panel' },
    { id: '5e27937a749c83437054f214', name: 'Certificate Issued' },
    { id: '5d3f6c7eda7a38421829602f', name: 'Pre-Application' },
    { id: '5d3f6c7eda7a384218296031', name: 'Application Review' },
    { id: '5d3f6c7eda7a384218296035', name: 'Post Decision - Construction' }
  ];

  it('renders List names, not the ObjectIds the project record stores', async () => {
    routeFetch(url => {
      if (url.includes('/summary')) return json({ error: 'not found' }, 404);
      if (url.includes('dataset=List')) return listSearch(ID_ROWS);
      if (url.includes('/search?')) return json([{ searchResults: [], count: 0 }]);
      return json(ID_FACTS);
    });

    const el = await render();

    expect(squash(el.querySelector('.ps__eyebrow')?.textContent))
      .toBe('Environmental Assessment Act (2002) · Joint Review Panel');
    expect(squash(el.querySelector('.ps-status__label')?.textContent))
      .toBe('Certificate Issued, Post Decision - Construction');
    expect(squash(el.querySelector('.ps-status .ps__meta')?.textContent))
      .toBe('Phases: Pre-Application › Application Review › Post Decision - Construction (current phase)');
    // The tone reads the decision NAME, so an id-valued record used to fall through to neutral.
    expect(el.querySelector('.ps-status')?.className).toContain('ps-status--success');
    expect(el.textContent).not.toContain('5d3f6c7eda7a384218296035');
  });

  it('marks an id no List row matched instead of showing it as if it were a name', async () => {
    routeFetch(url => {
      if (url.includes('/summary')) return json({ error: 'not found' }, 404);
      // Every row but the phase the project is in, so one id is left with nothing behind it.
      if (url.includes('dataset=List')) {
        return listSearch(ID_ROWS.filter(row => row.id !== '5d3f6c7eda7a384218296035'));
      }
      if (url.includes('/search?')) return json([{ searchResults: [], count: 0 }]);
      return json(ID_FACTS);
    });

    const el = await render();

    const status = el.querySelector('.ps-status__label')!;
    expect(squash(status.textContent)).toBe('Certificate Issued, 5d3f6c7eda7a384218296035');
    expect(status.getAttribute('title'))
      .toBe('Not in the registry’s list of names: 5d3f6c7eda7a384218296035');
    // The names that did resolve are unaffected — one missing row is not a failed lookup.
    expect(el.querySelector('.ps__eyebrow')?.getAttribute('title')).toBeNull();
  });

  it('keeps a dated Track phase on the timeline instead of the phase line', async () => {
    // Track's `phases` shape: the same list, but each entry carries the date it was reached.
    const trackFacts = {
      ...MOCK_PROJECT_SUMMARY_FACTS,
      phaseHistory: [
        { name: 'Pre-Application', date: '2010-03-01' },
        { name: 'Application Review', dateCompleted: '2013-01-25' }
      ]
    };
    routeFetch(url => {
      if (url.includes('/summary')) return json({ error: 'not found' }, 404);
      if (url.includes('dataset=List')) return listSearch();
      if (url.includes('/search?')) return json([{ searchResults: [], count: 0 }]);
      return json(trackFacts);
    });

    const el = await render();

    expect(el.querySelector('.ps-status .ps__meta')).toBeNull();
    const labels = Array.from(el.querySelectorAll('.ps-timeline__label')).map(row => squash(row.textContent));
    expect(labels).toEqual(['Pre-Application', 'Application Review', 'Certificate E14-01 issued']);
  });

  it('resolves a dated phase row on the timeline as well as the undated ones', async () => {
    const datedIds = {
      ...MOCK_PROJECT_SUMMARY_FACTS,
      phaseHistory: [{ name: '5d3f6c7eda7a38421829602f', date: '2010-03-01' }]
    };
    routeFetch(url => {
      if (url.includes('/summary')) return json({ error: 'not found' }, 404);
      if (url.includes('dataset=List')) return listSearch(ID_ROWS);
      if (url.includes('/search?')) return json([{ searchResults: [], count: 0 }]);
      return json(datedIds);
    });

    const el = await render();

    const labels = Array.from(el.querySelectorAll('.ps-timeline__label')).map(row => squash(row.textContent));
    expect(labels).toEqual(['Pre-Application', 'Certificate E14-01 issued']);
  });

  it('renders the conditions and opens the dialog on the card', async () => {
    routeFetch(url => {
      if (url.includes('/summary')) return json(MOCK_PROJECT_SUMMARY);
      if (url.includes('dataset=List')) return listSearch();
      if (url.includes('/search?')) {
        return json([{ searchResults: MOCK_ORGANIZATIONS.map(o => ({ ...o, _id: o.id })), count: MOCK_ORGANIZATIONS.length }]);
      }
      return json(MOCK_PROJECT_SUMMARY_FACTS);
    });

    const el = await render();

    const cards = el.querySelectorAll<HTMLButtonElement>('.ps-card--action');
    expect(cards.length).toBe(MOCK_PROJECT_SUMMARY.sections!.conditions!.items.length);
    expect(cards[0].textContent).toContain('Construction Environmental Management Plan');
    // The badge is the disclosure, so it must be present wherever generated text is.
    expect(el.textContent).toContain('AI-generated from the sources below');

    const dialog = el.querySelector('dialog')!;
    expect(dialog.open).toBeFalse();

    cards[0].click();
    fixture.detectChanges();

    // `open`, not merely present in the DOM: the element is always rendered, and an earlier
    // version of this component set the signal without ever calling showModal().
    expect(dialog.open).toBeTrue();
    expect(dialog.textContent).toContain(MOCK_PROJECT_SUMMARY.sections!.conditions!.items[0].bullets![0]);
    expect(dialog.textContent).toContain('see the certificate for binding wording');
    // Every bullet list carries the citation chips that ground it.
    expect(dialog.querySelectorAll('.ps-cite').length).toBeGreaterThan(0);

    // Escape and the Close button both arrive as the dialog's own `close` event.
    dialog.close();
    await settle(2);
    fixture.detectChanges();
    expect(dialog.open).toBeFalse();
    expect(dialog.textContent?.trim()).toBe('');
    // Focus goes back to the card that opened it, not to the top of the page.
    expect(document.activeElement).toBe(cards[0]);
  });

  it('renders an unmatched nation name as a plain cited row, not a card', async () => {
    routeFetch(url => {
      if (url.includes('/summary')) return json(MOCK_PROJECT_SUMMARY);
      if (url.includes('dataset=List')) return listSearch();
      if (url.includes('/search?')) {
        return json([{ searchResults: MOCK_ORGANIZATIONS.map(o => ({ ...o, _id: o.id })), count: MOCK_ORGANIZATIONS.length }]);
      }
      return json(MOCK_PROJECT_SUMMARY_FACTS);
    });

    const el = await render();

    const unmatched = el.querySelectorAll('.ps-unmatched');
    expect(unmatched.length).toBe(1);
    expect(unmatched[0].textContent).toContain('Saulteau First Nations');
    expect(unmatched[0].textContent).toContain('no organisation record matched');
    // No address, and no website link the join never verified.
    expect(unmatched[0].querySelector('a')).toBeNull();

    const nationSection = el.querySelector('[aria-labelledby="ps-nations-h"]')!;
    const cards = nationSection.querySelectorAll('.ps-card');
    expect(cards.length).toBe(4);
    expect(cards[0].textContent).toContain('Rose Prairie');
  });
});
