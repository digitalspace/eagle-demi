import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import FIXTURE from '../../parity/fixtures/workplans.json';
import type { WorkplanRow } from '../api/sheet-works';
import { rowsOf } from './derive';
import { StatusListView } from './StatusList';

const TODAY = '2026-11-17';

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

describe('StatusListView', () => {
  it('exposes its column headers', () => {
    renderList();
    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent);
    expect(headers).toEqual(['Work', 'Current phase', 'Days in phase', 'Next milestone', 'Lifecycle', 'Est. decision']);
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

  it('shows closed sheet works under the Closed tile', async () => {
    const user = renderList();
    expect(screen.queryByRole('link', { name: /\(1996\)/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: /Closed/ }));
    expect(screen.getByRole('link', { name: 'Sample Delta Pipeline - Assessment (1996)' })).toBeInTheDocument();
  });

  it('counts only open works in the footer by default, and says where the closed ones are', () => {
    renderList();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Showing 6 of 6 open works. 8 closed works are under the Closed tile.',
    );
  });

  it('renders closed works 200 at a time', async () => {
    const closed = (FIXTURE.works as WorkplanRow[]).find((work) => work.source === 'sheet')!;
    const user = renderList(Array.from({ length: 201 }, (_, i) => ({ ...closed, workId: `w${i}` })));
    await user.click(screen.getByRole('button', { name: /Closed/ }));
    expect(bodyRows()).toHaveLength(200);
    await user.click(screen.getByRole('button', { name: 'Show 1 more' }));
    expect(bodyRows()).toHaveLength(201);
  });
});
