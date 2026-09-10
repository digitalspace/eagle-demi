import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
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
        provideRouter([]),
        // After provideRouter, so the stubbed snapshot wins over the router's own ActivatedRoute.
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

  // The screen is reached from the picker and from a deep link; both need the way back.
  it('links back to the project list', async () => {
    routeFetch(url => {
      if (url.includes('/summary')) return json({ error: 'not found' }, 404);
      if (url.includes('dataset=List')) return listSearch();
      if (url.includes('/search?')) return json([{ searchResults: [], count: 0 }]);
      return json(MOCK_PROJECT_SUMMARY_FACTS);
    });

    const back = (await render()).querySelector<HTMLAnchorElement>('.ps__back')!;

    expect(back.getAttribute('href')).toBe('/projects');
    expect(squash(back.textContent)).toContain('All projects');
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
    expect(labels).toEqual(['Certificate E14-01 issued', 'Application Review', 'Pre-Application']);
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
    expect(labels).toEqual(['Certificate E14-01 issued', 'Pre-Application']);
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

  /** The whole page from the fixture: facts, summary, organisations and an empty List table. */
  function routeWholePage(summary: unknown = MOCK_PROJECT_SUMMARY) {
    routeFetch(url => {
      if (url.includes('/summary')) return json(summary);
      if (url.includes('dataset=List')) return listSearch();
      if (url.includes('/search?')) {
        return json([{ searchResults: MOCK_ORGANIZATIONS.map(o => ({ ...o, _id: o.id })), count: MOCK_ORGANIZATIONS.length }]);
      }
      return json(MOCK_PROJECT_SUMMARY_FACTS);
    });
  }

  it('orders the whole timeline newest first and sinks undated events to the end', async () => {
    // An extracted event is the only row that can reach the timeline without a date: a phase row
    // and an amendment row are both dropped upstream when theirs is missing. `null` and
    // `undefined` both compare as strings above real dates (`"null"`, `"undefined"` > `"2023-…"`),
    // so they only sink to the end because of the explicit falsy-date guard in the comparator.
    routeWholePage({
      ...MOCK_PROJECT_SUMMARY,
      sections: {
        ...MOCK_PROJECT_SUMMARY.sections,
        timelineEvents: [
          ...MOCK_PROJECT_SUMMARY.sections!.timelineEvents!,
          { date: '', label: 'Panel hearings held across the Peace region', citations: [8] },
          { date: null, label: 'Undated event with a null date', citations: [9] } as any,
          { date: undefined, label: 'Undated event with an undefined date', citations: [10] } as any
        ]
      }
    });

    const el = await render();

    // Fact rows and extracted rows interleave: they are one list, sorted after the merge, not two
    // lists rendered one after the other.
    const dates = Array.from(el.querySelectorAll('.ps-timeline__date')).map(row => squash(row.textContent));
    expect(dates).toEqual([
      '21 Jun 2023',
      '2 Nov 2021',
      '26 Feb 2021',
      '15 Aug 2019',
      '2 Aug 2017',
      '14 Oct 2014',
      '1 May 2014',
      '19 Jan 2011',
      '—',
      '—',
      '—'
    ]);
    const first = el.querySelector('.ps-timeline__label')!;
    expect(squash(first.textContent)).toContain('Amendment #8');
  });

  it('folds every citation list behind a collapsed Sources count', async () => {
    routeWholePage();

    const el = await render();

    const status = el.querySelector('.ps-status')!;
    const fold = status.querySelector<HTMLDetailsElement>('details.ps-sources')!;
    // Collapsed by default: the sentence is what the reader came for.
    expect(fold.open).toBeFalse();
    expect(squash(fold.querySelector('summary')?.textContent)).toBe('Sources (1)');
    // The count is the number of chips behind the fold, not a hard-coded label.
    expect(fold.querySelectorAll('.ps-cite').length).toBe(1);

    // The same fold wherever a generated claim carries citations, because there is one template.
    const timelineFold = el.querySelector('.ps-timeline__row--ai details.ps-sources')!;
    expect(squash(timelineFold.querySelector('summary')?.textContent)).toBe('Sources (1)');
    const lists = Array.from(el.querySelectorAll('.ps-cites'));
    expect(lists.length).toBeGreaterThan(1);
    expect(lists.every(list => !!list.closest('details.ps-sources'))).toBeTrue();
  });

  it('labels the condition card action Open', async () => {
    routeWholePage();

    const el = await render();

    const cues = Array.from(el.querySelectorAll('.ps-card__cue')).map(cue => squash(cue.textContent));
    expect(cues.length).toBe(MOCK_PROJECT_SUMMARY.sections!.conditions!.items.length);
    expect(new Set(cues)).toEqual(new Set(['Open']));
    expect(el.textContent).not.toContain('Tap for summary');
  });

  it('shows the one-line note and no sources for a section that generated nothing', async () => {
    // `nations: null` is what the generator writes when no certificate or assessment report was
    // readable. The section used to keep its badge and its citation chips: sources for a claim
    // nobody made.
    routeWholePage({
      ...MOCK_PROJECT_SUMMARY,
      sections: { ...MOCK_PROJECT_SUMMARY.sections, nations: null }
    });

    const el = await render();

    const section = el.querySelector('[aria-labelledby="ps-nations-h"]')!;
    expect(squash(section.querySelector('.ps-note')?.textContent))
      .toBe('No nations were read from this project’s documents, so none are listed.');
    expect(section.querySelectorAll('details.ps-sources').length).toBe(0);
    expect(section.querySelectorAll('.ps-cite').length).toBe(0);
    expect(section.querySelectorAll('.ps-card').length).toBe(0);
    expect(section.textContent).not.toContain('AI-generated from the sources below');
  });

  it('drops a nation note with no name rather than render its sources under a blank', async () => {
    routeWholePage({
      ...MOCK_PROJECT_SUMMARY,
      sections: {
        ...MOCK_PROJECT_SUMMARY.sections,
        nations: [{ name: '   ', organizationId: null, citations: [11] }]
      }
    });

    const el = await render();

    const section = el.querySelector('[aria-labelledby="ps-nations-h"]')!;
    expect(section.querySelectorAll('.ps-unmatched').length).toBe(0);
    expect(section.querySelectorAll('details.ps-sources').length).toBe(0);
    expect(section.querySelector('.ps-note')).not.toBeNull();
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

  // Federal, read from the IAAC registry ---------------------------------------------------

  /** A decision statement as the registry lists it: ids and a PDF, none of which DEMI resolves. */
  const IAAC_FACTS = {
    status: 'Decision Statement issued',
    cearId: '80105',
    projectUrl: 'https://iaac-aeic.gc.ca/050/evaluations/proj/80105',
    latest: { title: 'Annual report on the implementation of conditions', date: '2024-07-03', docId: '164236' },
    decision: {
      docId: '157936',
      title: 'Decision Statement issued under section 54',
      date: '2014-10-14',
      pdfUrl: 'https://iaac-aeic.gc.ca/050/documents/p80105/157936E.pdf',
      pageCount: 12
    }
  };

  const IAAC_CITATION = {
    n: 13,
    chunkId: 'iaac:157936:2',
    documentId: 'iaac:157936',
    pageNumber: 2,
    documentName: 'Decision Statement issued under section 54',
    source: 'iaac',
    url: 'https://iaac-aeic.gc.ca/050/documents/p80105/157936E.pdf'
  };

  const IAAC_FEDERAL = {
    source: 'iaac',
    sourceDocumentId: 'iaac:157936',
    facts: IAAC_FACTS,
    items: [{
      n: 1,
      category: 'Fish and fish habitat',
      title: 'Offsetting plan',
      oneLiner: 'The proponent must offset residual effects on fish habitat.',
      bullets: ['An offsetting plan is filed before construction begins.'],
      citations: [13]
    }]
  };

  /** The whole page with a federal section the registry supplied, plus its one extra citation. */
  const withIaacFederal = (federal: unknown = IAAC_FEDERAL) => ({
    ...MOCK_PROJECT_SUMMARY,
    sections: { ...MOCK_PROJECT_SUMMARY.sections, federal },
    citations: [...MOCK_PROJECT_SUMMARY.citations!, IAAC_CITATION]
  });

  it('links an IAAC citation to the registry PDF and leaves the DEMI chip on the document route', async () => {
    routeWholePage(withIaacFederal());

    const el = await render();
    const registry = TestBed.inject(RegistryStateService);
    const download = spyOn(registry, 'getDownloadUrl').and.resolveTo('https://demi.example/doc.pdf');
    spyOn(window, 'open');

    // The federal card's sources live in the dialog, which is where the registry chip renders.
    el.querySelector<HTMLButtonElement>('[aria-labelledby="ps-federal-h"] .ps-card--action')!.click();
    fixture.detectChanges();

    const chip = el.querySelector<HTMLAnchorElement>('dialog .ps-cite')!;
    expect(chip.tagName).toBe('A');
    expect(chip.getAttribute('href')).toBe(IAAC_CITATION.url);
    expect(chip.getAttribute('target')).toBe('_blank');
    expect(chip.getAttribute('rel')).toBe('noopener');
    expect(chip.getAttribute('title')).toBe(IAAC_CITATION.documentName);
    expect(squash(chip.textContent)).toContain('IAAC registry, p. 2');
    // `iaac:157936` resolves to nothing in DEMI, so the download must never be asked for it.
    // The listener keeps the click from actually navigating the test runner to the registry.
    chip.addEventListener('click', event => event.preventDefault(), { once: true });
    chip.click();
    expect(download).not.toHaveBeenCalled();

    // A modal left open sits in the top layer and takes the focus every later spec asserts on.
    el.querySelector('dialog')!.close();
    await settle(2);
    fixture.detectChanges();

    // The DEMI chips on the same page are untouched: still buttons, still the document route.
    const demiChip = el.querySelector<HTMLButtonElement>('.ps-status .ps-cite')!;
    expect(demiChip.tagName).toBe('BUTTON');
    demiChip.click();
    expect(download).toHaveBeenCalledWith(MOCK_PROJECT_SUMMARY.citations![0].documentId, '272');
  });

  it('renders an IAAC citation with no PDF url as a non-link chip, never a bare href', async () => {
    // The registry can list a document without ever finding a PDF for it. An anchor with
    // href="" would still be focusable and would open a second copy of the current page.
    const citationNoUrl = { ...IAAC_CITATION, url: undefined };
    routeWholePage({
      ...withIaacFederal(),
      citations: [...MOCK_PROJECT_SUMMARY.citations!, citationNoUrl]
    });

    const el = await render();
    el.querySelector<HTMLButtonElement>('[aria-labelledby="ps-federal-h"] .ps-card--action')!.click();
    fixture.detectChanges();

    const chip = el.querySelector('dialog .ps-cite')!;
    expect(chip.tagName).toBe('SPAN');
    expect(chip.querySelector('a')).toBeNull();
    expect(chip.getAttribute('title')).toBe(IAAC_CITATION.documentName);
    expect(squash(chip.textContent)).toContain('IAAC registry, p. 2');
    expect(squash(chip.textContent)).toContain('Open PDF');

    // A modal left open sits in the top layer and takes the focus every later spec asserts on.
    el.querySelector('dialog')!.close();
    await settle(2);
    fixture.detectChanges();
  });

  it('puts the registry fact row above the federal cards', async () => {
    routeWholePage(withIaacFederal());

    const el = await render();

    const section = el.querySelector('[aria-labelledby="ps-federal-h"]')!;
    const row = section.querySelector('.ps-federal')!;
    expect(squash(row.textContent)).toContain(
      'Federal assessment: Decision Statement issued · Decision Statement issued under section 54 ' +
      '(14 Oct 2014) · View on IAAC registry'
    );

    const links = row.querySelectorAll<HTMLAnchorElement>('a');
    expect(links[0].getAttribute('href')).toBe(IAAC_FACTS.projectUrl);
    expect(links[1].getAttribute('href')).toBe(IAAC_FACTS.decision.pdfUrl);
    expect(squash(links[1].textContent)).toContain('Decision statement (PDF, 12 pages)');
    expect(links[1].getAttribute('rel')).toBe('noopener');

    // The facts read before anything generated from them.
    expect(row.compareDocumentPosition(section.querySelector('.ps-cards')!))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(section.textContent).toContain('AI-generated from the sources below');
  });

  it('states that Canada has issued no decision, with no AI badge and no sources', async () => {
    // The registry was read and answered: no decision statement. That is a fact about the project,
    // not a section that failed, so the facts render and nothing generated does.
    routeWholePage(withIaacFederal({
      source: 'iaac',
      facts: { ...IAAC_FACTS, decision: undefined },
      items: [],
      reason: 'no_federal_decision'
    }));

    const el = await render();

    const section = el.querySelector('[aria-labelledby="ps-federal-h"]')!;
    expect(squash(section.querySelector('.ps-federal')?.textContent)).toContain(
      'Federal assessment: Decision Statement issued · No federal decision statement yet · ' +
      'Latest: Annual report on the implementation of conditions (3 Jul 2024) · View on IAAC registry'
    );
    expect(section.textContent).not.toContain('AI-generated from the sources below');
    expect(section.querySelectorAll('details.ps-sources').length).toBe(0);
    expect(section.querySelectorAll('.ps-card--action').length).toBe(0);
    // Only the registry link: with no decision there is no PDF to offer.
    expect(section.querySelectorAll('.ps-federal a').length).toBe(1);
  });

  it('offers the decision PDF when the registry held one its text would not read', async () => {
    routeWholePage(withIaacFederal({
      source: 'iaac',
      facts: { ...IAAC_FACTS, decision: { ...IAAC_FACTS.decision, pageCount: undefined } },
      items: [],
      reason: 'federal_decision_unreadable'
    }));

    const el = await render();

    const section = el.querySelector('[aria-labelledby="ps-federal-h"]')!;
    const row = section.querySelector('.ps-federal')!;
    expect(squash(row.textContent)).toContain(
      'Federal assessment: Decision Statement issued · Decision Statement issued under section 54 ' +
      '(14 Oct 2014) · View on IAAC registry'
    );
    // The page count is what could not be read, so the link says PDF and stops there.
    const pdf = row.querySelectorAll<HTMLAnchorElement>('a')[1];
    expect(pdf.getAttribute('href')).toBe(IAAC_FACTS.decision.pdfUrl);
    expect(squash(pdf.textContent)).toContain('Decision statement (PDF)');
    expect(squash(section.querySelector('.ps-note')?.textContent))
      .toBe('Decision statement found on the IAAC registry but its text could not be read.');

    expect(section.textContent).not.toContain('AI-generated from the sources below');
    expect(section.querySelectorAll('details.ps-sources').length).toBe(0);
    expect(section.querySelectorAll('.ps-card--action').length).toBe(0);
  });

  it('renders the fact row and no badge when a federal section arrives with no items key', async () => {
    // A registry-only payload from an older generator run: `items` was never written, not just
    // set empty. The guard must read that the same way `items: []` reads, not throw building the
    // page.
    routeWholePage(withIaacFederal({ source: 'iaac', facts: IAAC_FACTS }));

    const el = await render();

    const section = el.querySelector('[aria-labelledby="ps-federal-h"]')!;
    expect(squash(section.querySelector('.ps-federal')?.textContent)).toContain(
      'Federal assessment: Decision Statement issued · Decision Statement issued under section 54 ' +
      '(14 Oct 2014) · View on IAAC registry'
    );
    expect(section.textContent).not.toContain('AI-generated from the sources below');
    expect(section.querySelectorAll('.ps-card--action').length).toBe(0);
  });

  it('keeps the no-federal-document note when the section is null', async () => {
    // `federal: null` in the fixture: nothing was read at all, which is not the same as a registry
    // that answered. The note stands, and nothing generated renders beside it.
    routeWholePage();

    const el = await render();

    const section = el.querySelector('[aria-labelledby="ps-federal-h"]')!;
    expect(squash(section.querySelector('.ps-note')?.textContent)).toBe(
      'No federal decision document for this project is in the registry, so no federal conditions are shown.'
    );
    expect(section.querySelector('.ps-federal')).toBeNull();
    expect(section.textContent).not.toContain('AI-generated from the sources below');
    expect(section.querySelectorAll('.ps-card--action').length).toBe(0);
  });

  it('names the document a not-extracted section is waiting on', async () => {
    routeWholePage({
      ...MOCK_PROJECT_SUMMARY,
      sections: { ...MOCK_PROJECT_SUMMARY.sections, nations: null },
      sectionErrors: { nations: 'not_extracted' },
      sectionSources: { nations: { documentId: 'mock-doc-app', displayName: 'Environmental Impact Statement' } }
    });

    const el = await render();
    const registry = TestBed.inject(RegistryStateService);
    const download = spyOn(registry, 'getDownloadUrl').and.resolveTo('https://demi.example/doc.pdf');
    spyOn(window, 'open');

    const note = el.querySelector('[aria-labelledby="ps-nations-h"] .ps-note')!;
    expect(squash(note.textContent))
      .toBe('Environmental Impact Statement is in the registry but not yet extracted.');
    expect(note.textContent).not.toContain('no organisation record matched');

    note.querySelector<HTMLButtonElement>('button')!.click();
    expect(download).toHaveBeenCalledWith('mock-doc-app', '272');
  });

  it('keeps the generic empty-state line for any other reason', async () => {
    // The source row is deliberately present: the line is chosen by the REASON, not by whether a
    // document happens to be named, so "not yet extracted" cannot leak onto another reason.
    routeWholePage({
      ...MOCK_PROJECT_SUMMARY,
      sections: { ...MOCK_PROJECT_SUMMARY.sections, nations: null },
      sectionErrors: { nations: 'no_document' },
      sectionSources: { nations: { documentId: 'mock-doc-app', displayName: 'Environmental Impact Statement' } }
    });

    const el = await render();

    const note = el.querySelector('[aria-labelledby="ps-nations-h"] .ps-note')!;
    expect(squash(note.textContent))
      .toBe('No nations were read from this project’s documents, so none are listed.');
    expect(note.querySelector('button')).toBeNull();
  });

  it('tags a French key document and leaves the rest unmarked', async () => {
    const [certificate, ...rest] = MOCK_PROJECT_SUMMARY.facts!.keyDocuments!;
    routeWholePage({
      ...MOCK_PROJECT_SUMMARY,
      facts: {
        ...MOCK_PROJECT_SUMMARY.facts,
        keyDocuments: [{ ...certificate, languageFlag: 'fr' }, ...rest]
      }
    });

    const el = await render();

    const titles = el.querySelectorAll('[aria-labelledby="ps-docs-h"] .ps-card__title');
    expect(squash(titles[0].textContent))
      .toBe('Environmental Assessment Certificate #E14-01 FR — French-language document');
    expect(titles[0].querySelector('.pill')?.textContent).toContain('FR');
    expect(titles[1].querySelector('.pill')).toBeNull();
  });
});
