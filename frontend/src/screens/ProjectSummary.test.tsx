import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ProjectSummary } from './ProjectSummary';
import { ANONYMOUS_SESSION, SessionContext, type Session } from '../session/session';
import { queryWrapper, testQueryClient, withQueryClient } from '../test-query';
import { LINKS_QUERY } from '../api/links';
import { projectFactsKey, type ProjectFacts } from '../api/project-summary';
import { json } from '../test-http';
import { localIso } from '../test-dates';

// Vitest hands CSS imports back empty, `?raw` included, so the sheet is read from disk (cwd frontend/).
// `@types/node` is not in this app's tsconfig.
const node = (globalThis as unknown as {
  process: { getBuiltinModule(id: 'node:fs'): { readFileSync(path: string, encoding: 'utf8'): string } };
}).process;
const styles = node.getBuiltinModule('node:fs').readFileSync('src/styles.css', 'utf8');

const PROJECT_ID = '272';

/** The one instant whose clock is asserted, so it carries an hour rather than the default noon. */
const GENERATED_AT = localIso(2026, 1, 3, 14, 5);

const FACTS = {
  id: PROJECT_ID,
  name: 'Site C Clean Energy Project',
  eagleId: '588511d5aaecd9001b8266fe',
  proponentName: 'BC Hydro',
  region: 'Peace',
  address: 'Fort St John',
  legislation: '2002 Act',
  eacDecision: 'Certificate Issued',
  currentPhaseName: '5d3f6c7eda7a384218296035',
  decisionDate: localIso(2014, 9, 14),
  eaCertificate: 'E14-02',
  phaseHistory: ['Pre-Application', 'Post Decision - Construction'],
  shortCode: 'site-c',
  shortUrl: 'https://projects.eao.gov.bc.ca/s/site-c',
  legacyShortCodes: [],
  shortLinkUrl: 'https://projects.eao.gov.bc.ca/p/588511d5aaecd9001b8266fe',
};

const SAVED_CODE = {
  shortCode: 'site-c-dam',
  shortUrl: 'https://projects.eao.gov.bc.ca/s/site-c-dam',
  legacyShortCodes: ['site-c'],
  url: FACTS.shortLinkUrl,
  shortLinkCustom: false,
};

const NEW_TARGET = 'https://www.env.gov.bc.ca/site-c';

const LIST_ROWS = [{ id: '5d3f6c7eda7a384218296035', name: 'Post Decision - Construction' }];

const CITATIONS = [
  { n: 1, chunkId: 'c1', documentId: 'doc1', pageNumber: 4, documentName: 'Schedule B' },
  { n: 2, chunkId: 'c2', documentId: 'iaac:158078', pageNumber: 9, documentName: 'Decision', source: 'iaac', url: 'https://iaac.example/158078.pdf' },
  { n: 3, chunkId: 'c3', documentId: 'iaac:900', pageNumber: 2, documentName: 'Older decision', source: 'iaac', url: 'https://iaac.example/900', format: 'html' },
  { n: 4, chunkId: 'c4', documentId: 'iaac:901', pageNumber: 1, documentName: 'Unfiled', source: 'iaac' },
];

const SUMMARY = {
  id: 'ps-272',
  projectId: PROJECT_ID,
  generatedAt: GENERATED_AT,
  model: 'a-model',
  estimatedCostCad: 0.0123,
  citations: CITATIONS,
  facts: {
    amendments: [{ documentId: 'amd1', displayName: 'Amendment 1', datePosted: localIso(2016, 2, 2) }],
    inspections: { count: 3, latest: { documentId: 'i1', displayName: 'Inspection', datePosted: localIso(2020, 5, 1) } },
    selfReports: { count: 7 },
    keyDocuments: [
      { documentId: 'doc1', displayName: 'Certificate E14-02', role: 'certificate' },
      { documentId: 'doc2', displayName: 'Certificat E14-02', role: 'scheduleA', languageFlag: 'fr' },
    ],
  },
  sections: {
    status: { sentence: 'The certificate is in force.', citations: [1] },
    conditions: {
      items: [
        { n: 1, category: 'Water', title: 'Watercourse crossings', oneLiner: 'Crossings are monitored.', bullets: ['Monitor quarterly'], citations: [1] },
      ],
    },
    amendments: [{ documentId: 'amd1', sentence: 'The amendment extended the deadline.', citations: [1] }],
    timelineEvents: [
      { date: localIso(2018, 0, 2), label: 'Construction started', citations: [1] },
      { date: '', label: 'Undated event' },
    ],
    compliance: { paragraph: 'Inspections found no major issues.', citations: [1] },
    nations: [
      { name: 'Sample Nation', organizationId: 'org1', citations: [1] },
      { name: 'Unmatched Nation', organizationId: null, citations: [2] },
      { name: '   ', organizationId: null, citations: [1] },
    ],
    federal: {
      source: 'iaac',
      items: [{ n: 9, category: 'Fish', title: 'Fish habitat', oneLiner: 'Offsetting required.', citations: [2] }],
      facts: {
        status: 'Decision issued',
        cearId: '158078',
        projectUrl: 'https://iaac.example/p/158078',
        latest: null,
        // Date-only on purpose: the registry files a decision as a day, and the screen must read it
        // as that day rather than as UTC midnight, which is the day before in BC.
        decision: { title: 'Decision Statement', date: '2014-10-14', docId: '900', pdfUrl: 'https://iaac.example/d.pdf', pageCount: 12 },
      },
    },
  },
};

const ORGANIZATIONS = [{ id: 'org1', name: 'Sample Nation', address1: '1 Main St', city: 'Victoria', website: 'https://nation.example' }];

const STAFF: Partial<Session> = { authenticated: true, isStaff: true, settled: true };

/** A staffer holding a write role, which is who may change a project's short URL. */
const EDITOR: Partial<Session> = { ...STAFF, roles: ['staff'] };

interface Stubs {
  facts?: Response;
  summary?: Response;
  /** A promise that is never settled holds the PUT open. */
  shortCode?: Response | Promise<Response>;
}

function stub({ facts, summary, shortCode }: Stubs = {}) {
  const fetchMock = vi.fn((input: unknown, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/summary')) return Promise.resolve(summary ?? json(SUMMARY));
    if (url.includes('/short-code')) return Promise.resolve(shortCode ?? json(SAVED_CODE));
    if (url.includes('dataset=List')) return Promise.resolve(json([{ searchResults: LIST_ROWS }]));
    if (url.includes('dataset=Organization')) return Promise.resolve(json([{ searchResults: ORGANIZATIONS }]));
    if (url.includes(`/projects/${PROJECT_ID}`) || url.includes(`/projects/${FACTS.eagleId}`)) {
      return Promise.resolve(facts ?? json(FACTS));
    }
    return Promise.resolve(json({}));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function screenTree(session: Partial<Session>, path: string, entry: string) {
  return (
    <MemoryRouter initialEntries={[entry]}>
      <SessionContext.Provider value={{ ...ANONYMOUS_SESSION, ...session }}>
        <Routes>
          <Route path={path} element={<ProjectSummary />} />
        </Routes>
      </SessionContext.Provider>
    </MemoryRouter>
  );
}

function renderProject(session: Partial<Session> = STAFF, path = '/projects/:id', entry = `/projects/${PROJECT_ID}`) {
  return render(withQueryClient(screenTree(session, path, entry)));
}

const sourcesToggles = () => screen.queryAllByText(/^Sources \(\d+\)$/);

/** The timeline `<ol>`, which shares its role with the amendment and citation lists. */
const timelineRows = (): HTMLElement => document.querySelector('.ps-timeline') as HTMLElement;

/** The provenance footer, whose sentence is several text nodes and so has no queryable name. */
const footer = (): HTMLElement | null => document.querySelector('.ps-footer');

beforeEach(() => {
  // jsdom implements neither, and the condition dialog is the screen's only modal.
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true;
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('ProjectSummary', () => {
  it('renders the project facts and links back to the project list', async () => {
    stub();

    renderProject();

    expect(await screen.findByRole('heading', { level: 1, name: FACTS.name })).toBeInTheDocument();
    expect(screen.getByText(/Fort St John · Peace region/)).toBeInTheDocument();
    expect(screen.getByText('BC Hydro')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /All projects/ })).toHaveAttribute('href', '/projects');
    expect(screen.getByText('Decision').closest('div')).toHaveTextContent('14 Oct 2014');
  });

  it('renders List names, not the ObjectIds the project record stores', async () => {
    stub();

    renderProject();

    expect(await screen.findByRole('heading', { level: 2, name: /Certificate Issued/ })).toHaveTextContent(
      'Certificate Issued, Post Decision - Construction',
    );
    expect(screen.queryByText(/5d3f6c7eda7a384218296035/)).not.toBeInTheDocument();
  });

  it('reads Eagle phase names as a sequence under the status, not as timeline rows', async () => {
    stub();

    renderProject();

    const phases = await screen.findByText(/^Phases:/);
    expect(phases).toHaveTextContent('Pre-Application');
    expect(phases).toHaveTextContent('Post Decision - Construction');
    expect(within(timelineRows()).queryByText('Pre-Application')).not.toBeInTheDocument();
  });

  // The Angular template spaces the chevron on both sides; without the space the sequence reads
  // "Pre-Application› Post Decision". Text content, not a regex, so the spacing is the assertion.
  it('spaces the chevron between a plain phase and the current one', async () => {
    stub();

    renderProject();

    const phases = await screen.findByText(/^Phases:/);
    expect(phases.textContent).toBe('Phases: Pre-Application › Post Decision - Construction (current phase)');
  });

  it('orders the timeline newest first and sinks an undated event to the end', async () => {
    stub();

    renderProject();

    await screen.findByRole('heading', { name: 'Timeline' });
    // Direct children only: an AI row nests its own citation list inside the same <ol>.
    const rows = [...timelineRows().children].map((row) => row.textContent ?? '');
    expect(rows[0]).toContain('Construction started');
    expect(rows[1]).toContain('Amendment 1');
    expect(rows[2]).toContain('Certificate E14-02 issued');
    expect(rows[rows.length - 1]).toContain('Undated event');
  });

  it('folds every citation list behind a collapsed Sources count', async () => {
    stub();

    renderProject();

    await screen.findByText('The certificate is in force.');
    const toggles = sourcesToggles();
    expect(toggles.length).toBeGreaterThan(0);
    for (const toggle of toggles) {
      expect(toggle.closest('details')).not.toHaveAttribute('open');
    }
  });

  it('links an IAAC citation to the registry PDF and leaves the DEMI chip a button', async () => {
    stub();

    renderProject();

    await screen.findByText('The certificate is in force.');
    await userEvent.click(sourcesToggles()[0]);

    const demiChips = screen.getAllByRole('button', { name: /Schedule B/ });
    expect(demiChips.length).toBeGreaterThan(0);
    expect(demiChips[0]).toHaveTextContent('Open document');

    // The citation chip, not the fact row's "View on IAAC registry" link, which shares the words.
    const registryLink = screen
      .getAllByRole('link', { name: /IAAC registry/ })
      .find((link) => link.classList.contains('ps-cite'))!;
    expect(registryLink).toHaveAttribute('href', 'https://iaac.example/158078.pdf');
    expect(registryLink).toHaveTextContent('Open PDF');
    expect(registryLink).toHaveTextContent('IAAC registry, p. 9');
  });

  it('labels a registry page citation as a page, with no page number', async () => {
    // An older decision was never filed as a file: the registry prints it on the document page.
    const sections = { ...SUMMARY.sections, status: { ...SUMMARY.sections.status, citations: [3] } };
    stub({ summary: json({ ...SUMMARY, sections }) });

    renderProject();

    await screen.findByText('The certificate is in force.');
    await userEvent.click(sourcesToggles()[0]);

    const chip = screen
      .getAllByRole('link', { name: /IAAC registry/ })
      .find((link) => link.getAttribute('href') === 'https://iaac.example/900')!;
    expect(chip).toHaveTextContent('Open registry page');
    expect(chip).not.toHaveTextContent('Open PDF');
    // The page text is cut into pages by length, so a page number would point at nothing.
    expect(chip).toHaveTextContent('IAAC registry');
    expect(chip).not.toHaveTextContent('p.');
  });

  it('opens the condition dialog from the card and closes it again', async () => {
    stub();

    renderProject();

    const card = await screen.findByRole('button', { name: /Watercourse crossings/ });
    await userEvent.click(card);

    const dialog = screen.getByRole('dialog', { hidden: true });
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Watercourse crossings');
    expect(within(dialog).getByText('Monitor quarterly')).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByText('Monitor quarterly')).not.toBeInTheDocument());
  });

  it('renders an unmatched nation as a plain cited row and drops a nameless note', async () => {
    stub();

    renderProject();

    expect(await screen.findByText('Sample Nation')).toBeInTheDocument();
    expect(screen.getByText('1 Main St, Victoria')).toBeInTheDocument();
    expect(screen.getByText('Unmatched Nation')).toBeInTheDocument();
    expect(screen.getByText('named in the documents; no organisation record matched')).toBeInTheDocument();
    // Three notes were sent, one of them nameless: two rows, not three.
    expect(screen.getAllByText(/Nation$/)).toHaveLength(2);
  });

  it('puts the registry fact row above the federal cards', async () => {
    stub();

    renderProject();

    const line = await screen.findByText(/Federal assessment: Decision issued/);
    expect(line).toHaveTextContent('Decision Statement (14 Oct 2014)');
    expect(within(line).getByRole('link', { name: /View on IAAC registry/ })).toHaveAttribute(
      'href',
      'https://iaac.example/p/158078',
    );
    expect(within(line).getByRole('link', { name: /Decision statement \(PDF, 12 pages\)/ })).toHaveAttribute(
      'href',
      'https://iaac.example/d.pdf',
    );
  });

  it('tags a French key document and leaves the rest unmarked', async () => {
    stub();

    renderProject();

    const french = await screen.findByText('FR');
    expect(french.closest('.ps-card')).toHaveTextContent('Certificat E14-02');
    expect(screen.getByText('Certificate E14-02').closest('.ps-card')).not.toHaveTextContent('FR');
  });

  it('names the document a not-extracted section is waiting on', async () => {
    stub({
      summary: json({
        ...SUMMARY,
        sections: { ...SUMMARY.sections, nations: [], federal: null },
        sectionErrors: { nations: 'not_extracted' },
        sectionSources: { nations: { documentId: 'doc9', displayName: 'Assessment Report' } },
      }),
    });

    renderProject();

    expect(await screen.findByRole('button', { name: 'Assessment Report' })).toBeInTheDocument();
    expect(screen.getByText(/is in the registry but not yet extracted/)).toBeInTheDocument();
  });

  it('keeps the facts and says there is no generated summary when the row is missing', async () => {
    stub({ summary: json({ error: 'not found' }, 404) });

    renderProject();

    expect(await screen.findByText('No generated summary for this project yet.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: FACTS.name })).toBeInTheDocument();
    expect(screen.queryByText(/AI-generated from the sources below/)).not.toBeInTheDocument();
  });

  it('keeps the error line for a summary read that actually failed', async () => {
    stub({ summary: json({ error: 'boom' }, 500) });

    renderProject();

    expect(
      await screen.findByText('The generated summary could not be loaded. The project record above is unaffected.'),
    ).toBeInTheDocument();
  });

  // The app gate sends a signed-out reader to the sign-in screen, so this branch is only reachable
  // mid-visit: the token was good enough to open the page and expired before the summary read.
  it('asks a reader whose token expired mid-visit to sign in, and keeps the facts', async () => {
    stub({ summary: json({ error: 'unauthorized' }, 401) });

    renderProject();

    expect(
      await screen.findByText('Sign in to view the generated summary. The project record above is public.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: FACTS.name })).toBeInTheDocument();
    expect(screen.getByText('BC Hydro')).toBeInTheDocument();
  });

  it('never sends the staff-only request for a session that is not staff', async () => {
    const fetchMock = stub();

    renderProject({ settled: true });

    await screen.findByRole('heading', { level: 1, name: FACTS.name });
    expect(fetchMock.mock.calls.map((call) => String(call[0])).some((url) => url.includes('/summary'))).toBe(false);
  });

  it('prints the cost estimate in the footer beside the model that earned it', async () => {
    stub();

    renderProject();

    await screen.findByText('The certificate is in force.');
    expect(footer()).toHaveTextContent('Generated 3 Feb 2026, 14:05 by a-model, est. CA$0.0123.');
  });

  // Angular's currency pipe prints nothing for null; `cad(null)` would print "CA$0.0000", which
  // reads as a priced record that cost nothing rather than as a record nobody priced.
  it('prints no estimate when the record carries none', async () => {
    stub({ summary: json({ ...SUMMARY, estimatedCostCad: null }) });

    renderProject();

    await screen.findByText('The certificate is in force.');
    expect(footer()).toHaveTextContent('Generated 3 Feb 2026, 14:05 by a-model.');
    expect(footer()).not.toHaveTextContent('est.');
    expect(footer()).not.toHaveTextContent('CA$');
  });

  // A disabled query is pending for ever, so reading isPending would leave both skeletons up with
  // no request on its way.
  it('shows no loading state on a route that carries no project id', async () => {
    stub();

    renderProject(STAFF, '/projects', '/projects');

    await screen.findByRole('link', { name: /All projects/ });
    expect(screen.queryByText('Loading the project record…')).not.toBeInTheDocument();
    expect(screen.queryByText('Loading the generated conditions…')).not.toBeInTheDocument();
  });

  // The cache outlives a session change. Without isStaff in the key the signed-out reader's
  // `signin` answer is the cached one, and signing in reads back the sign-in line.
  it('reads the summary again once the session is staff', async () => {
    stub();
    const Wrapper = queryWrapper();

    const signedOut = render(<Wrapper>{screenTree({ settled: true }, '/projects/:id', `/projects/${PROJECT_ID}`)}</Wrapper>);
    await screen.findByText('Sign in to view the generated summary. The project record above is public.');
    signedOut.unmount();

    render(<Wrapper>{screenTree(STAFF, '/projects/:id', `/projects/${PROJECT_ID}`)}</Wrapper>);

    // The first paint, before any refetch: under one shared key this is the cached sign-in line.
    expect(
      screen.queryByText('Sign in to view the generated summary. The project record above is public.'),
    ).not.toBeInTheDocument();
    expect(await screen.findByText('The certificate is in force.')).toBeInTheDocument();
  });

  // Every read carries the query's own signal, so leaving the page aborts it instead of parsing a
  // body nothing will render.
  it('gives every read an abort signal', async () => {
    const fetchMock = stub();

    renderProject();

    await screen.findByText('The certificate is in force.');
    await screen.findByText('1 Main St, Victoria');
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('names the status when the project record cannot be read', async () => {
    stub({ facts: json({ error: 'boom' }, 500) });

    renderProject();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the project (HTTP 500).');
  });
});

describe('ProjectSummary short URL', () => {
  const editButton = () => screen.findByRole('button', { name: 'Edit short URL' });
  const codeInput = () => screen.getByRole('textbox', { name: 'Short URL' });
  const puts = (fetchMock: ReturnType<typeof stub>) =>
    fetchMock.mock.calls.filter(([input]) => String(input).includes('/short-code'));

  async function openEditor(ui = () => renderProject(EDITOR)) {
    const user = userEvent.setup();
    ui();
    await user.click(await editButton());
    return user;
  }

  async function typeCode(user: ReturnType<typeof userEvent.setup>, code: string) {
    await user.clear(codeInput());
    await user.type(codeInput(), code);
  }

  async function saveCode(user: ReturnType<typeof userEvent.setup>, code: string) {
    await typeCode(user, code);
    await user.click(screen.getByRole('button', { name: 'Save' }));
  }

  afterEach(() => vi.useRealTimers());

  it('shows the short URL and copies it', async () => {
    stub();
    const user = userEvent.setup();
    renderProject();

    const link = await screen.findByRole('link', { name: 'projects.eao.gov.bc.ca/s/site-c' });
    expect(link).toHaveAttribute('href', FACTS.shortUrl);
    await user.click(screen.getByRole('button', { name: 'Copy short URL' }));

    // userEvent installs its own clipboard, so this reads back what the screen actually wrote.
    await expect(navigator.clipboard.readText()).resolves.toBe(FACTS.shortUrl);
    expect(screen.getByRole('status')).toHaveTextContent('Copied');
  });

  it('clears the copy confirmation after two seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stub();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderProject();

    await user.click(await screen.findByRole('button', { name: 'Copy short URL' }));
    expect(screen.getByRole('status')).toHaveTextContent('Copied');
    act(() => vi.advanceTimersByTime(2000));

    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('lists the old codes that still redirect', async () => {
    stub({ facts: json({ ...FACTS, legacyShortCodes: ['sitec', 'site-c-old'] }) });

    renderProject();

    expect(
      await screen.findByText('Also works: projects.eao.gov.bc.ca/s/sitec, projects.eao.gov.bc.ca/s/site-c-old'),
    ).toBeInTheDocument();
  });

  it('builds nothing from a short URL that does not end in the code', async () => {
    const shortUrl = 'https://projects.eao.gov.bc.ca/s/other';
    stub({ facts: json({ ...FACTS, shortUrl, legacyShortCodes: ['sitec'] }) });

    renderProject();

    expect(await screen.findByRole('link', { name: shortUrl })).toHaveAttribute('href', shortUrl);
    expect(screen.getByText('Also works: sitec')).toBeInTheDocument();
  });

  it('renders no short URL block for a project without a code', async () => {
    const { shortCode: _code, shortUrl: _url, ...withoutCode } = FACTS;
    stub({ facts: json(withoutCode) });

    renderProject(EDITOR);

    await screen.findByRole('heading', { level: 1, name: FACTS.name });
    expect(screen.queryByRole('button', { name: 'Copy short URL' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit short URL' })).not.toBeInTheDocument();
  });

  it('hides Edit from a staffer without a write role', async () => {
    stub();

    renderProject({ ...STAFF, roles: ['compliance'] });

    await screen.findByRole('link', { name: 'projects.eao.gov.bc.ca/s/site-c' });
    expect(screen.queryByRole('button', { name: 'Edit short URL' })).not.toBeInTheDocument();
  });

  it('hides Edit from a write role the session does not treat as staff', async () => {
    stub();

    renderProject({ authenticated: true, settled: true, isStaff: false, roles: ['staff'] });

    await screen.findByRole('link', { name: 'projects.eao.gov.bc.ca/s/site-c' });
    expect(screen.queryByRole('button', { name: 'Edit short URL' })).not.toBeInTheDocument();
  });

  it('hides Edit from the machine write role', async () => {
    stub();

    renderProject({ ...STAFF, roles: ['demi-service-write'] });

    await screen.findByRole('link', { name: 'projects.eao.gov.bc.ca/s/site-c' });
    expect(screen.queryByRole('button', { name: 'Edit short URL' })).not.toBeInTheDocument();
  });

  it('sends the PUT to the DEMI id when the page was opened by Eagle ObjectId', async () => {
    const fetchMock = stub();
    const user = await openEditor(() => renderProject(EDITOR, '/projects/:id', `/projects/${FACTS.eagleId}`));

    await saveCode(user, 'site-c-dam');

    await waitFor(() => expect(puts(fetchMock)).toHaveLength(1));
    expect(String(puts(fetchMock)[0][0])).toMatch(new RegExp(`/projects/${PROJECT_ID}/short-code$`));
  });

  it('leaves focus where it was on the first render', async () => {
    stub();

    renderProject(EDITOR);

    await editButton();
    expect(document.body).toHaveFocus();
  });

  it('opens the editor on the current code behind the fixed host prefix', async () => {
    stub();

    await openEditor();

    expect(codeInput()).toHaveValue('site-c');
    expect(codeInput()).toHaveFocus();
    expect(codeInput()).toHaveAccessibleDescription(/projects\.eao\.gov\.bc\.ca\/s\/.*old link will keep working/);
  });

  it('lowercases the code as it is typed', async () => {
    stub();
    const user = await openEditor();

    await typeCode(user, 'Site-C-Dam');

    expect(codeInput()).toHaveValue('site-c-dam');
  });

  it('flags a changed code the API would refuse and will not save it', async () => {
    const fetchMock = stub();
    const user = await openEditor();

    await typeCode(user, 'a b');
    expect(codeInput()).toHaveAttribute('aria-invalid', 'true');
    expect(codeInput()).toHaveAccessibleDescription(/Use 3 to 64 characters/);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(puts(fetchMock)).toHaveLength(0);
  });

  it('holds the error for an emptied field until it loses focus', async () => {
    stub();
    const user = await openEditor();

    await user.clear(codeInput());
    expect(codeInput()).not.toHaveAttribute('aria-invalid');
    await user.tab();

    expect(codeInput()).toHaveAttribute('aria-invalid', 'true');
  });

  it('sends nothing when Enter submits an invalid code', async () => {
    const fetchMock = stub();
    const user = await openEditor();

    await typeCode(user, 'ab{Enter}');

    expect(codeInput()).toHaveAttribute('aria-invalid', 'true');
    expect(puts(fetchMock)).toHaveLength(0);
  });

  it('saves the new code, shows the new URL and returns focus to Edit', async () => {
    const fetchMock = stub();
    const user = await openEditor();

    await saveCode(user, 'site-c-dam');

    expect(await screen.findByRole('link', { name: 'projects.eao.gov.bc.ca/s/site-c-dam' })).toBeInTheDocument();
    expect(screen.getByText('Also works: projects.eao.gov.bc.ca/s/site-c')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit short URL' })).toHaveFocus());
    const [[, init]] = puts(fetchMock);
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual({ shortCode: 'site-c-dam' });
  });

  it('marks the short links list stale after a save', async () => {
    stub();
    const client = testQueryClient();
    client.setQueryData(LINKS_QUERY, []);
    const Wrapper = queryWrapper(client);
    const user = await openEditor(() =>
      render(<Wrapper>{screenTree(EDITOR, '/projects/:id', `/projects/${PROJECT_ID}`)}</Wrapper>),
    );

    await saveCode(user, 'site-c-dam');

    await waitFor(() => expect(client.getQueryState(LINKS_QUERY)?.isInvalidated).toBe(true));
  });

  it('shows Saving and locks both buttons while the request is open', async () => {
    stub({ shortCode: new Promise<Response>(() => undefined) });
    const user = await openEditor();

    await saveCode(user, 'site-c-dam');

    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.click(codeInput());
    await user.keyboard('{Escape}');
    expect(codeInput()).toBeInTheDocument();
  });

  // fireEvent: a native double submit bypasses the disabled button, which userEvent always respects.
  it('sends one request for a double submit', async () => {
    const fetchMock = stub({ shortCode: new Promise<Response>(() => undefined) });
    const user = await openEditor();
    await typeCode(user, 'site-c-dam');
    const form = codeInput().closest('form') as HTMLFormElement;

    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(puts(fetchMock)).toHaveLength(1);
  });

  it('says inline when the code is already taken', async () => {
    stub({ shortCode: json({ error: 'Code already in use' }, 409) });
    const user = await openEditor();

    await saveCode(user, 'taken-code');

    await waitFor(() => expect(codeInput()).toHaveAccessibleDescription(/That short URL is taken\./));
    expect(codeInput()).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows the server text inline for a refused code', async () => {
    stub({ shortCode: json({ error: 'That code is reserved' }, 400) });
    const user = await openEditor();

    await saveCode(user, 'admin');

    await waitFor(() => expect(codeInput()).toHaveAccessibleDescription(/That code is reserved/));
  });

  it('puts a 400 about the project in the callout, not on the field', async () => {
    stub({ shortCode: json({ error: 'An Eagle id is needed before a short code can be set' }, 400) });
    const user = await openEditor();

    await saveCode(user, 'site-c-dam');

    expect(await screen.findByRole('alert')).toHaveTextContent('An Eagle id is needed before a short code can be set');
    expect(codeInput()).not.toHaveAttribute('aria-invalid');
  });

  it.each([
    [403, { error: 'Forbidden' }, 'Forbidden'],
    [503, { error: 'Write conflict, try again' }, 'Write conflict, try again'],
    [404, { error: 'Project not found' }, 'Project not found'],
    [404, { message: 'Project not found' }, 'Project not found'],
  ])('puts a %i answer in the callout and keeps the editor open (%o)', async (status, body, text) => {
    stub({ shortCode: json(body, status) });
    const user = await openEditor();

    await saveCode(user, 'site-c-dam');

    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(codeInput()).not.toHaveAttribute('aria-invalid');
    expect(codeInput()).toHaveValue('site-c-dam');
  });

  it('clears the callout on Cancel', async () => {
    stub({ shortCode: json({ error: 'Forbidden' }, 403) });
    const user = await openEditor();
    await saveCode(user, 'site-c-dam');
    await screen.findByRole('alert');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('cancels without saving and returns focus to Edit', async () => {
    const fetchMock = stub();
    const user = await openEditor();

    await user.type(codeInput(), '-x');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit short URL' })).toHaveFocus());
    expect(screen.getByRole('link', { name: 'projects.eao.gov.bc.ca/s/site-c' })).toBeInTheDocument();
    expect(puts(fetchMock)).toHaveLength(0);
  });

  it('cancels on Escape', async () => {
    const fetchMock = stub();
    const user = await openEditor();

    await user.type(codeInput(), '-x{Escape}');

    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit short URL' })).toHaveFocus());
    expect(screen.queryByRole('textbox', { name: 'Short URL' })).not.toBeInTheDocument();
    expect(puts(fetchMock)).toHaveLength(0);
  });

  it('wraps a long short URL instead of widening the page', async () => {
    stub();
    const sheet = document.createElement('style');
    sheet.textContent = styles;
    document.head.append(sheet);
    try {
      renderProject();

      const link = await screen.findByRole('link', { name: 'projects.eao.gov.bc.ca/s/site-c' });
      const block = link.closest('.ps-short') as HTMLElement;
      expect(getComputedStyle(block).overflowWrap).toBe('anywhere');
    } finally {
      sheet.remove();
    }
  });
});

describe('ProjectSummary short URL target', () => {
  const targetInput = () => screen.getByRole('textbox', { name: 'Points to' });
  const codeInput = () => screen.getByRole('textbox', { name: 'Short URL' });
  const puts = (fetchMock: ReturnType<typeof stub>) =>
    fetchMock.mock.calls.filter(([input]) => String(input).includes('/short-code'));
  const sentBody = (fetchMock: ReturnType<typeof stub>) => JSON.parse(String(puts(fetchMock)[0][1]?.body));

  async function openEditor() {
    const user = userEvent.setup();
    renderProject(EDITOR);
    await user.click(await screen.findByRole('button', { name: 'Edit short URL' }));
    return user;
  }

  async function typeTarget(user: ReturnType<typeof userEvent.setup>, url: string) {
    await user.clear(targetInput());
    await user.type(targetInput(), url);
  }

  const save = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: 'Save' }));

  it('shows where the short URL points', async () => {
    stub();

    renderProject();

    expect(await screen.findByRole('link', { name: FACTS.shortLinkUrl })).toHaveAttribute('href', FACTS.shortLinkUrl);
  });

  it('opens the Points to field empty while the link uses the project page', async () => {
    stub();

    await openEditor();

    expect(targetInput()).toHaveValue('');
    expect(targetInput()).toHaveAccessibleDescription(/Leave empty to open the project page/);
  });

  it('opens the Points to field on a custom target', async () => {
    stub({ facts: json({ ...FACTS, shortLinkUrl: NEW_TARGET, shortLinkCustom: true }) });

    await openEditor();

    expect(targetInput()).toHaveValue(NEW_TARGET);
  });

  it('changes nothing when the project page is chosen for a link already on it', async () => {
    const fetchMock = stub();
    const user = await openEditor();

    await user.click(screen.getByRole('button', { name: 'Use the project page' }));
    await user.type(targetInput(), '{Enter}');

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(puts(fetchMock)).toHaveLength(0);
  });

  it('sends nothing when Enter submits an unchanged form', async () => {
    const fetchMock = stub();
    const user = await openEditor();

    await user.type(codeInput(), '{Enter}');

    expect(codeInput()).toBeInTheDocument();
    expect(puts(fetchMock)).toHaveLength(0);
  });

  it('sends only the code when only the code changed', async () => {
    const fetchMock = stub();
    const user = await openEditor();

    await user.clear(codeInput());
    await user.type(codeInput(), 'site-c-dam');
    await save(user);

    await waitFor(() => expect(puts(fetchMock)).toHaveLength(1));
    expect(sentBody(fetchMock)).toEqual({ shortCode: 'site-c-dam' });
  });

  it('sends only the target when only the target changed, then shows it', async () => {
    const fetchMock = stub({
      shortCode: json({ ...SAVED_CODE, shortCode: 'site-c', shortUrl: FACTS.shortUrl, url: NEW_TARGET, shortLinkCustom: true }),
    });
    const user = await openEditor();

    await typeTarget(user, NEW_TARGET);
    await save(user);

    expect(await screen.findByRole('link', { name: NEW_TARGET })).toHaveAttribute('href', NEW_TARGET);
    expect(sentBody(fetchMock)).toEqual({ url: NEW_TARGET });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit short URL' })).toHaveFocus());
  });

  it('sends the code and the target together when both changed', async () => {
    const fetchMock = stub({ shortCode: json({ ...SAVED_CODE, url: NEW_TARGET }) });
    const user = await openEditor();

    await user.clear(codeInput());
    await user.type(codeInput(), 'site-c-dam');
    await typeTarget(user, NEW_TARGET);
    await save(user);

    await waitFor(() => expect(puts(fetchMock)).toHaveLength(1));
    expect(sentBody(fetchMock)).toEqual({ shortCode: 'site-c-dam', url: NEW_TARGET });
  });

  it('points the link back at the project page with url null', async () => {
    const fetchMock = stub({
      facts: json({ ...FACTS, shortLinkUrl: NEW_TARGET, shortLinkCustom: true }),
      shortCode: json({ ...SAVED_CODE, shortCode: 'site-c', shortUrl: FACTS.shortUrl, url: FACTS.shortLinkUrl }),
    });
    const user = await openEditor();

    await user.click(screen.getByRole('button', { name: 'Use the project page' }));
    expect(targetInput()).toHaveValue('');
    expect(targetInput()).toHaveFocus();
    await save(user);

    expect(await screen.findByRole('link', { name: FACTS.shortLinkUrl })).toBeInTheDocument();
    expect(sentBody(fetchMock)).toEqual({ url: null });
  });

  it.each(['http://www.env.gov.bc.ca/site-c', 'ftp://files.gov.bc.ca/x', 'site c page'])(
    'flags %s as not an https address and will not save it',
    async (bad) => {
    const fetchMock = stub();
    const user = await openEditor();

    await typeTarget(user, bad);
    await save(user);

    expect(targetInput()).toHaveAttribute('aria-invalid', 'true');
    expect(targetInput()).toHaveAccessibleDescription(/starts with https:\/\/\./);
    expect(puts(fetchMock)).toHaveLength(0);
    },
  );

  it('puts a refused target on the Points to field, not the code', async () => {
    stub({ shortCode: json({ error: 'url host is not on the allowlist' }, 400) });
    const user = await openEditor();

    await user.clear(codeInput());
    await user.type(codeInput(), 'site-c-dam');
    await typeTarget(user, NEW_TARGET);
    await save(user);

    await waitFor(() => expect(targetInput()).toHaveAccessibleDescription(/url host is not on the allowlist/));
    expect(targetInput()).toHaveAttribute('aria-invalid', 'true');
    expect(codeInput()).not.toHaveAttribute('aria-invalid');
  });

  it('marks every cached project and the links list stale after a save', async () => {
    stub();
    const client = testQueryClient();
    client.setQueryData(['project-facts', 'another-project'], FACTS);
    client.setQueryData(LINKS_QUERY, []);
    const Wrapper = queryWrapper(client);
    const user = userEvent.setup();
    render(<Wrapper>{screenTree(EDITOR, '/projects/:id', `/projects/${PROJECT_ID}`)}</Wrapper>);
    await user.click(await screen.findByRole('button', { name: 'Edit short URL' }));

    await typeTarget(user, NEW_TARGET);
    await save(user);

    await waitFor(() => expect(client.getQueryState(['project-facts', 'another-project'])?.isInvalidated).toBe(true));
    expect(client.getQueryState(LINKS_QUERY)?.isInvalidated).toBe(true);
  });

  it('re-reads the project and the links list after a 503', async () => {
    const fetchMock = stub({ shortCode: json({ error: 'Write conflict, try again' }, 503) });
    const factReads = () => fetchMock.mock.calls.filter(([input]) => String(input).endsWith(`/projects/${PROJECT_ID}`)).length;
    const client = testQueryClient();
    client.setQueryData(LINKS_QUERY, []);
    const Wrapper = queryWrapper(client);
    const user = userEvent.setup();
    render(<Wrapper>{screenTree(EDITOR, '/projects/:id', `/projects/${PROJECT_ID}`)}</Wrapper>);
    await user.click(await screen.findByRole('button', { name: 'Edit short URL' }));

    await typeTarget(user, NEW_TARGET);
    const readsBefore = factReads();
    await save(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('Write conflict, try again');
    expect(client.getQueryState(LINKS_QUERY)?.isInvalidated).toBe(true);
    await waitFor(() => expect(factReads()).toBeGreaterThan(readsBefore));
  });

  it('lets Save retry a 503 once the re-read shows the new target', async () => {
    const fetchMock = stub();
    const base = fetchMock.getMockImplementation()!;
    const moved = { ...FACTS, shortLinkUrl: NEW_TARGET, shortLinkCustom: true };
    let putCount = 0;
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.includes('/short-code')) {
        putCount += 1;
        return Promise.resolve(
          putCount === 1
            ? json({ error: 'A short link was being written by another request. Try again.' }, 503)
            : json({ ...SAVED_CODE, shortCode: 'site-c', shortUrl: FACTS.shortUrl, legacyShortCodes: [], url: NEW_TARGET, shortLinkCustom: true }),
        );
      }
      // The row was written before the 503, so every read after it has the new target.
      if (putCount > 0 && url.endsWith(`/projects/${PROJECT_ID}`)) return Promise.resolve(json(moved));
      return base(input, init);
    });
    const client = testQueryClient();
    const Wrapper = queryWrapper(client);
    const user = userEvent.setup();
    render(<Wrapper>{screenTree(EDITOR, '/projects/:id', `/projects/${PROJECT_ID}`)}</Wrapper>);
    await user.click(await screen.findByRole('button', { name: 'Edit short URL' }));

    await typeTarget(user, NEW_TARGET);
    await save(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('Try again');
    await waitFor(() =>
      expect(client.getQueryData<ProjectFacts>(projectFactsKey(PROJECT_ID))?.shortLinkUrl).toBe(NEW_TARGET),
    );
    await save(user);

    expect(await screen.findByRole('link', { name: NEW_TARGET })).toHaveAttribute('href', NEW_TARGET);
    expect(puts(fetchMock)).toHaveLength(2);
    expect(JSON.parse(String(puts(fetchMock)[1][1]?.body))).toEqual({ url: NEW_TARGET });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps Save off until the code or the target changes', async () => {
    stub();
    const user = await openEditor();

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await typeTarget(user, NEW_TARGET);

    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });
});
