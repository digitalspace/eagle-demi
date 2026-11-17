import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { NrptiPanel } from './NrptiPanel';
import { json } from '../test-http';
import { withQueryClient } from '../test-query';

const BRUCEJACK = '588511caaaecd9001b825bcb';
const NO_RECORDS = 'No NRPTI records beyond those already published on EPIC.';
const NO_MINE_OR_RECORDS =
  'NRPTI has no mine or compliance records linked to this project beyond what EPIC already publishes.';

type Rows = Record<string, unknown>[];
type Part = 'mines' | 'byProject' | 'byMine';

const page = (rows: Rows) => json([{ searchResults: rows, meta: [{ searchResultsTotal: rows.length }] }]);

/** Answers each NRPTI read by which part of the panel sent it; a promise held open keeps that part loading. */
function stubNrpti(answers: Partial<Record<Part, () => Response | Promise<Response>>>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const q = new URL(String(input)).searchParams;
      const part: Part | null =
        q.get('dataset') === 'MineBCMI'
          ? 'mines'
          : q.has('and[_epicProjectId]')
            ? 'byProject'
            : q.has('and[mineGuid]')
              ? 'byMine'
              : null;
      return (part && answers[part]?.()) ?? page([]);
    }),
  );
}

function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((r) => (resolve = r));
  return { promise, resolve };
}

const MINE = { _id: 'm1', _sourceRefId: 'g1', name: 'Brucejack Mine' };

const record = (id: string, schema: string, dateIssued: string) => ({
  _id: id,
  _schemaName: schema,
  recordName: `Record ${id}`,
  dateIssued,
});

const detailsOf = (summaryText: string) => screen.getByText(summaryText).closest('details');

afterEach(() => vi.unstubAllGlobals());

describe('NrptiPanel', () => {
  it('keeps the parts that loaded when another part fails', async () => {
    stubNrpti({
      mines: () => page([MINE]),
      byProject: () => json({ error: 'down' }, 500),
    });

    render(withQueryClient(<NrptiPanel eagleId={BRUCEJACK} />));

    // The NRPTI reads retry once, after react-query's 1 s delay.
    expect(await screen.findByRole('alert', {}, { timeout: 4000 })).toHaveTextContent(
      'NRPTI could not be reached for some or all of this project.',
    );
    expect(screen.getByText('Brucejack Mine')).toBeInTheDocument();
    expect(screen.queryByText(NO_RECORDS)).not.toBeInTheDocument();
  });

  it('says NRPTI has nothing only once every part has answered', async () => {
    const byProject = deferred();
    stubNrpti({ mines: () => page([]), byProject: () => byProject.promise });

    render(withQueryClient(<NrptiPanel eagleId={BRUCEJACK} />));

    expect(await screen.findByText('Loading NRPTI records…')).toBeInTheDocument();
    expect(screen.queryByText(NO_MINE_OR_RECORDS)).not.toBeInTheDocument();

    byProject.resolve(page([]));

    expect(await screen.findByText(NO_MINE_OR_RECORDS)).toBeInTheDocument();
  });

  it.each([
    { records: [record('a', 'Permit', '2024-01-01')], said: '1 NRPTI record loaded' },
    {
      records: [record('a', 'Permit', '2024-01-01'), record('b', 'Inspection', '2020-01-01')],
      said: '2 NRPTI records loaded',
    },
  ])('tells a screen reader "$said" once every part has answered', async ({ records, said }) => {
    stubNrpti({ byProject: () => page(records) });

    render(withQueryClient(<NrptiPanel eagleId={BRUCEJACK} />));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(new RegExp(`^${said}$`)));
  });

  // aria-busy would have screen readers skip the status line while parts are still loading.
  it('never marks the section busy while it loads', async () => {
    stubNrpti({ byProject: () => deferred().promise });

    render(withQueryClient(<NrptiPanel eagleId={BRUCEJACK} />));
    await screen.findByText('Loading NRPTI records…');

    expect(screen.getByRole('region', { name: 'NRPTI (CORE stand-in)' })).not.toHaveAttribute('aria-busy');
  });

  it('groups records by kind in the fixed kind order, not by date', async () => {
    stubNrpti({
      byProject: () =>
        page([record('permit', 'Permit', '2024-01-01'), record('inspection', 'Inspection', '2020-01-01')]),
    });

    render(withQueryClient(<NrptiPanel eagleId={BRUCEJACK} />));
    await screen.findByText('Record permit');

    expect(screen.getAllByText(/^\w[\w -]* \(\d+\)$/).map((summary) => summary.textContent)).toEqual([
      'Inspection (1)',
      'Permit (1)',
    ]);
  });

  // Folding is decided on the final count, so a kind that grows past ten after an early part lands starts shut.
  it('folds a kind with more than ten records and opens smaller ones, once every part has landed', async () => {
    const mines = deferred();
    stubNrpti({
      mines: () => mines.promise,
      byProject: () => page([record('early', 'Inspection', '2025-01-01')]),
      byMine: () =>
        page([
          ...Array.from({ length: 11 }, (_, i) => record(`late-${i}`, 'Inspection', '2020-01-01')),
          record('permit', 'Permit', '2021-01-01'),
        ]),
    });

    render(withQueryClient(<NrptiPanel eagleId={BRUCEJACK} />));
    await screen.findByText('Record early');
    mines.resolve(page([MINE]));
    await screen.findByText('Inspection (12)');

    expect(detailsOf('Inspection (12)')).not.toHaveAttribute('open');
    expect(detailsOf('Permit (1)')).toHaveAttribute('open');
  });
});
