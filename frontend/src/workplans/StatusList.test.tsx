import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FIXTURE from '../../parity/fixtures/workplans.json';
import SHEET from '../../parity/fixtures/projects-901-sheet-works.json';
import type { WorkplanRow } from '../api/sheet-works';
import { json } from '../test-http';
import { renderScreen } from '../test-query';
import { rowsOf } from './derive';
import { StatusListView } from './StatusList';

const TODAY = '2026-11-17';
const ALPHA_1996 = 'Sample Alpha Transmission Line - Assessment (1996)';
const ALPHA_2002 = 'Sample Alpha Transmission Line - Assessment (2002)';
const TRACK_WORK = 'Sample Alpha Transmission Line - Substation Assessment';

afterEach(() => vi.unstubAllGlobals());

function renderList(works = FIXTURE.works as WorkplanRow[]) {
  const rows = rowsOf(works, [], TODAY);
  render(
    <MemoryRouter>
      <StatusListView rows={rows} today={TODAY} />
    </MemoryRouter>,
  );
  return userEvent.setup();
}

const bodyRows = () => within(screen.getAllByRole('rowgroup')[1]).getAllByRole('row');
/** A cell of the one body row whose work link is `title`. */
const cellOf = (title: string, column: number) =>
  within(bodyRows().find((row) => within(row).queryByRole('link', { name: title }))!).getAllByRole('cell')[column];
const phaseCell = (title: string) => cellOf(title, 1);
const daysCell = (title: string) => cellOf(title, 2);
const work = (title: string) => structuredClone((FIXTURE.works as WorkplanRow[]).find((w) => w.title === title)!);

/** Epsilon's current phase is suspended in the fixture. */
function epsilonWith(extensionDays: number, suspendedDays: number): WorkplanRow {
  const epsilon = work('Sample Epsilon Terminal - Amendment');
  Object.assign(epsilon.phases[1], { extensionDays, suspendedDays });
  return epsilon;
}

describe('StatusListView', () => {
  it('exposes its column headers', () => {
    renderList();
    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent);
    expect(headers).toEqual([
      'Work',
      'Current phase',
      'Days in phase',
      'Next milestone',
      'Lifecycle (start → end)',
      'Est. decision',
    ]);
  });

  it('narrows to the overdue Track work when the Overdue tile is pressed', async () => {
    const user = renderList();
    const tile = screen.getByRole('button', { name: /Overdue/ });
    await user.click(tile);
    expect(tile).toHaveAttribute('aria-pressed', 'true');
    const rows = bodyRows();
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByRole('link', { name: 'Sample Alpha Transmission Line - Assessment' })).toBeInTheDocument();
  });

  it('clears the status filter when the pressed tile is pressed again', async () => {
    const user = renderList();
    const tile = screen.getByRole('button', { name: /Overdue/ });
    await user.click(tile);
    await user.click(tile);
    expect(tile).toHaveAttribute('aria-pressed', 'false');
    expect(bodyRows().length).toBeGreaterThan(1);
  });

  it('puts the attention summary in the filter bar', () => {
    render(
      <MemoryRouter>
        <StatusListView rows={rowsOf(FIXTURE.works as WorkplanRow[], [], TODAY)} today={TODAY} bar={(slots) => <p>{slots?.summary}</p>} />
      </MemoryRouter>,
    );
    expect(screen.getByText(`Sorted by attention · ${FIXTURE.works.length} works`)).toBeInTheDocument();
  });

  it('marks an overdue work’s next milestone as blocked by its current phase', () => {
    renderList();
    expect(cellOf('Sample Alpha Transmission Line - Assessment', 3)).toHaveTextContent(
      'Effects Assessment (blocked)Waiting on Application Review',
    );
  });

  it('lists the closed works it is given, with no Closed tile', () => {
    renderList();
    expect(screen.getByRole('link', { name: 'Sample Delta Pipeline - Assessment (1996)' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Closed/ })).toBeNull();
  });

  it('says how a closed work ended and opens a sheet work’s stored details under its row; a Track work has none', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => json(String(input).includes('/sheet-works') ? SHEET : {})));
    renderScreen(<StatusListView rows={rowsOf(FIXTURE.works as WorkplanRow[], [], TODAY)} today={TODAY} />);
    const user = userEvent.setup();

    expect(phaseCell(ALPHA_1996)).toHaveTextContent('ClosedWithdrawn');
    expect(phaseCell(ALPHA_2002)).toHaveTextContent('ClosedCertificate Issued (EAC)');
    expect(screen.getByRole('link', { name: TRACK_WORK })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `Details for ${TRACK_WORK}` })).toBeNull();

    const toggle = screen.getByRole('button', { name: `Details for ${ALPHA_2002}` });
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = screen.getByRole('region', { name: `${ALPHA_2002}, 2002 Act` });
    expect(toggle).toHaveAttribute('aria-controls', panel.id);
    const milestones = await within(panel).findByRole('list', { name: 'Milestones' });
    expect(within(milestones).getByText('Public comment period')).toBeInTheDocument();
    expect(within(panel).getByText('Assessment · Decision 14 Oct 2014')).toBeInTheDocument();
    expect(within(panel).getByText('Certificate Issued')).toBeInTheDocument();
  });

  it('counts the works shown in the footer', () => {
    renderList();
    expect(screen.getByText(`Showing 1–${FIXTURE.works.length} of ${FIXTURE.works.length}`)).toBeInTheDocument();
  });

  it('shows an open sheet work with no planned end as Status unknown', () => {
    const quarry = work('Sample Beta Quarry - Assessment (2002)');
    Object.assign(quarry, { isActive: null, workState: 'in-progress', decisionDate: null, outcome: null });
    Object.assign(quarry.phases[0], { isCompleted: false, endDate: null });
    renderList([...(FIXTURE.works as WorkplanRow[]), quarry]);

    expect(daysCell(quarry.title!)).toHaveTextContent('Status unknown');
  });

  it('stops the day count of a suspended work and says so', () => {
    renderList([epsilonWith(0, 0)]);
    expect(daysCell('Sample Epsilon Terminal - Amendment')).toHaveTextContent('311 d, suspended');
  });

  it('breaks out extension and suspended days above 0', () => {
    renderList([epsilonWith(30, 0)]);
    expect(within(daysCell('Sample Epsilon Terminal - Amendment')).getByText('includes 30 d extension')).toBeInTheDocument();
  });

  it('renders works 200 at a time', async () => {
    const closed = (FIXTURE.works as WorkplanRow[]).find((work) => work.source === 'sheet')!;
    const user = renderList(Array.from({ length: 201 }, (_, i) => ({ ...closed, workId: `w${i}` })));
    expect(bodyRows()).toHaveLength(200);
    await user.click(screen.getByRole('button', { name: 'Show 1 more' }));
    expect(bodyRows()).toHaveLength(201);
  });
});
