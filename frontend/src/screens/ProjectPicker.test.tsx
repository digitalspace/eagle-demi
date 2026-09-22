import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MAX_ROWS, ProjectPicker } from './ProjectPicker';
import { json } from '../test-http';
import { renderScreen } from '../test-query';

const PROJECTS = [
  { id: 272, name: 'Site C Clean Energy Project', region: 'Peace', proponent: { name: 'BC Hydro' } },
  { id: 111, name: 'Ajax Mine', region: 'Thompson-Okanagan', currentPhaseName: '5d3f6c7eda7a384218296035' },
  { id: 333, name: 'Coastal GasLink Pipeline', proponent: { name: 'TC Energy' } },
  { id: 444, name: 'ajax Creek Diversion' },
];

const PHASE_ROWS = [{ id: '5d3f6c7eda7a384218296035', name: 'Post Decision - Construction' }];

const projectSearch = (rows: unknown[], total?: number) =>
  json([{ count: total ?? rows.length, searchResults: rows }]);

/** The default: every project answered, phase names resolvable. */
function stub(rows: unknown[] = PROJECTS, total?: number) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      if (url.includes('dataset=List')) return Promise.resolve(json([{ searchResults: PHASE_ROWS }]));
      if (url.includes('dataset=Project')) return Promise.resolve(projectSearch(rows, total));
      return Promise.resolve(json([{ searchResults: [] }]));
    }),
  );
}

// The name element, not the link's whole accessible name: the ordering assertions are about the
// project name alone, and the secondary line sits in the same link.
const resultNames = () =>
  screen.queryAllByRole('link').map((link) => link.querySelector('.pp-result__name')?.textContent ?? '');

afterEach(() => vi.unstubAllGlobals());

describe('ProjectPicker', () => {
  it('lists every project alphabetically with a count', async () => {
    stub();

    renderScreen(<ProjectPicker />);

    expect(await screen.findByRole('link', { name: /Site C Clean Energy Project/ })).toBeInTheDocument();
    expect(resultNames()).toEqual([
      'ajax Creek Diversion',
      'Ajax Mine',
      'Coastal GasLink Pipeline',
      'Site C Clean Energy Project',
    ]);
    expect(screen.getByText('4 projects')).toBeInTheDocument();
  });

  it('filters on a case-insensitive substring of the name', async () => {
    const user = userEvent.setup();
    stub();

    renderScreen(<ProjectPicker />);
    await screen.findByRole('link', { name: /Ajax Mine/ });

    await user.type(screen.getByLabelText('Find a project'), 'AJAX');

    expect(resultNames()).toEqual(['ajax Creek Diversion', 'Ajax Mine']);
    expect(screen.getByText('2 projects')).toBeInTheDocument();
  });

  // Substring, not prefix: a reader who remembers "GasLink" should not have to know it is Coastal.
  it('matches inside the name', async () => {
    const user = userEvent.setup();
    stub();

    renderScreen(<ProjectPicker />);
    await screen.findByRole('link', { name: /Ajax Mine/ });

    await user.type(screen.getByLabelText('Find a project'), 'gaslink');

    expect(resultNames()).toEqual(['Coastal GasLink Pipeline']);
    expect(screen.getByText('1 project')).toBeInTheDocument();
  });

  it('names the query that matched nothing', async () => {
    const user = userEvent.setup();
    stub();

    renderScreen(<ProjectPicker />);
    await screen.findByRole('link', { name: /Ajax Mine/ });

    await user.type(screen.getByLabelText('Find a project'), 'quarry');

    expect(screen.getByRole('status')).toHaveTextContent('No project matches “quarry”.');
    expect(resultNames()).toEqual([]);
  });

  it('links each result at that project’s summary', async () => {
    stub();

    renderScreen(<ProjectPicker />);
    await screen.findByRole('link', { name: /Ajax Mine/ });

    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
      '/projects/444',
      '/projects/111',
      '/projects/333',
      '/projects/272',
    ]);
  });

  // The second line is the registry's own region line, as every other screen shows it: a row with
  // no region reads "British Columbia" rather than falling through to the proponent, and the phase
  // is not appended — the shared row does not carry one, and Angular's list does not show one.
  it('shows the region alone under each project name', async () => {
    stub();

    renderScreen(<ProjectPicker />);
    await screen.findByRole('link', { name: /Ajax Mine/ });

    expect(
      screen.getAllByRole('link').map((link) => link.querySelector('.pp-result__meta')?.textContent ?? ''),
    ).toEqual([
      'British Columbia', // ajax Creek Diversion: no region, no proponent
      'Thompson-Okanagan', // Ajax Mine: region, and a phase on the record
      'British Columbia', // Coastal GasLink: no region, a proponent
      'Peace', // Site C: region
    ]);
    expect(screen.queryByText(/Post Decision - Construction/)).not.toBeInTheDocument();
  });

  it('draws only the first page of matches and says how many there are', async () => {
    const many = Array.from({ length: MAX_ROWS + 12 }, (_, i) => ({
      id: 1000 + i,
      name: `Project ${String(i).padStart(3, '0')}`,
    }));
    stub(many);

    renderScreen(<ProjectPicker />);
    await screen.findByRole('link', { name: /Project 000/ });

    expect(screen.getAllByRole('link')).toHaveLength(MAX_ROWS);
    expect(screen.getByText(`${many.length} projects · showing the first ${MAX_ROWS}`)).toBeInTheDocument();
  });

  // The read is one page, so the loaded list is not always the registry. Never claim it is.
  it('says how much of the registry the one read covered', async () => {
    stub(PROJECTS, 900);

    renderScreen(<ProjectPicker />);

    expect(await screen.findByText('4 projects · 4 of 900 loaded')).toBeInTheDocument();
  });

  it('says no projects are visible rather than a blank-query non-match, when the registry is empty', async () => {
    stub([], 0);

    renderScreen(<ProjectPicker />);

    expect(await screen.findByRole('status')).toHaveTextContent('No projects are visible to you.');
    expect(screen.getByText('0 projects')).toBeInTheDocument();
  });

  // A 400 rather than a 500: a 500 is retried twice with a real delay before the read settles as
  // an error, and that retry budget is asserted in search.test.ts.
  it('reports a failed read instead of showing an empty registry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) =>
        Promise.resolve(
          String(input).includes('dataset=Project')
            ? json({ error: 'unknown parameter' }, 400)
            : json([{ searchResults: [] }]),
        ),
      ),
    );

    renderScreen(<ProjectPicker />);

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
    expect(screen.queryAllByRole('link')).toEqual([]);
    // No count over a failed read: "0 projects" would read as an empty registry.
    expect(screen.queryByText('0 projects')).not.toBeInTheDocument();
  });

  it('shows the skeleton while the project read is in flight, then clears it', async () => {
    let answer!: (res: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) =>
        String(input).includes('dataset=Project')
          ? new Promise<Response>((resolve) => {
              answer = resolve;
            })
          : Promise.resolve(json([{ searchResults: [] }])),
      ),
    );

    const { container } = renderScreen(<ProjectPicker />);

    expect(container.querySelectorAll('.skeleton').length).toBeGreaterThan(0);

    answer(projectSearch([{ id: 1, name: 'Only Project' }]));

    expect(await screen.findByRole('link', { name: /Only Project/ })).toBeInTheDocument();
    expect(container.querySelectorAll('.skeleton')).toHaveLength(0);
  });

  it('focuses the search box and walks into the results with the arrow keys', async () => {
    const user = userEvent.setup();
    stub();

    renderScreen(<ProjectPicker />);
    await screen.findByRole('link', { name: /Ajax Mine/ });

    const input = screen.getByLabelText('Find a project');
    expect(input).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    const rows = screen.getAllByRole('link');
    expect(rows[0]).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(rows[1]).toHaveFocus();

    await user.keyboard('{ArrowUp}');
    expect(rows[0]).toHaveFocus();

    await user.keyboard('{ArrowUp}');
    expect(input).toHaveFocus();
  });

  it('asks for one page of projects and one page of List names', async () => {
    stub();

    renderScreen(<ProjectPicker />);
    await screen.findByRole('link', { name: /Ajax Mine/ });

    const urls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(([input]) =>
      String(input),
    );
    await waitFor(() => expect(urls.some((url) => url.includes('dataset=List&pageSize=1000'))).toBe(true));
    expect(urls.some((url) => url.includes('/api/search?dataset=Project&pageSize=500'))).toBe(true);
  });
});
