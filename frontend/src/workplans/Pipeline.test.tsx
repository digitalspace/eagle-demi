import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import FIXTURE from '../../parity/fixtures/workplans.json';
import type { WorkplanRow } from '../api/sheet-works';
import { rowsOf } from './derive';
import { PipelineView } from './Pipeline';

const TODAY = '2026-11-17';
const WORKS = FIXTURE.works as WorkplanRow[];

function renderBoard(works = WORKS) {
  render(
    <MemoryRouter>
      <PipelineView rows={rowsOf(works, [], TODAY)} today={TODAY} />
    </MemoryRouter>,
  );
  return userEvent.setup();
}

const column = (name: string) => screen.getByRole('region', { name: new RegExp(`^${name} `) });
const titlesIn = (name: string) => within(column(name)).getAllByRole('link').map((link) => link.textContent);
const byTitle = (title: string) => WORKS.find((work) => work.title === title)!;

describe('PipelineView', () => {
  it('puts each open work in the column of its current phase, not-started works in Intake', () => {
    renderBoard();
    expect(titlesIn('Intake')).toEqual(['sample gamma wind farm - Assessment']);
    expect(titlesIn('Planning')).toEqual(['Sample Delta Pipeline - Assessment']);
    expect(titlesIn('Proponent time')).toEqual(['Sample Epsilon Terminal - Amendment']);
    expect(within(column('Decision')).getByText('No works in this stage.')).toBeInTheDocument();
  });

  it('sorts a column by most days over, then by share of the phase used, inactive works last', () => {
    const alpha = byTitle('Sample Alpha Transmission Line - Assessment');
    // Fewer days over than Alpha, but first by title.
    const aardvark: WorkplanRow = {
      ...structuredClone(alpha),
      workId: 'aardvark',
      title: 'Sample Aardvark - Assessment',
      phases: alpha.phases.map((phase) =>
        phase.name === 'Application Review' ? { ...phase, endDate: '2026-11-10T08:00:00.000Z' } : phase,
      ),
    };
    // Over its planned length, but inactive works show no bar, so that share must not rank it.
    const idle: WorkplanRow = { ...alpha, workId: 'idle', title: 'Sample Aaa Idle - Assessment', isActive: false };
    renderBoard([...WORKS, aardvark, idle]);
    expect(titlesIn('Review')).toEqual([
      'Sample Alpha Transmission Line - Assessment',
      'Sample Aardvark - Assessment',
      'Sample Beta Quarry - Substantial Start',
      'Sample Beta Quarry - Amendment',
      'Sample Aaa Idle - Assessment',
    ]);
  });

  it('says in text what the red and amber bars show', () => {
    renderBoard();
    expect(within(column('Review')).getByText('47 days overdue')).toBeInTheDocument();
    expect(column('Planning')).toHaveTextContent('88 % used');
  });

  it('shows when a not-started work starts and its first phase', () => {
    renderBoard();
    expect(column('Intake')).toHaveTextContent('Starts Feb 1, 2027');
    expect(column('Intake')).toHaveTextContent('First phase: Pre-EA');
  });

  it('shows Inactive in place of the days of a Track work switched off past its end', () => {
    renderBoard([{ ...byTitle('Sample Alpha Transmission Line - Assessment'), isActive: false }]);
    expect(within(column('Review')).getByText('Inactive')).toBeInTheDocument();
  });

  it('stops the day count of a work suspended now and says so, not used of planned', () => {
    renderBoard([byTitle('Sample Epsilon Terminal - Amendment')]);
    expect(column('Proponent time')).toHaveTextContent('311 d in phase, suspended');
  });

  it('renders 100 cards per column until Show more is pressed', async () => {
    const epsilon = byTitle('Sample Epsilon Terminal - Amendment');
    const many = Array.from({ length: 104 }, (_, i) => ({ ...epsilon, workId: `copy-${i}` }));
    const user = renderBoard([...WORKS, ...many]);
    expect(within(column('Proponent time')).getAllByRole('listitem')).toHaveLength(100);
    await user.click(screen.getByRole('button', { name: 'Show 5 more in Proponent time' }));
    expect(within(column('Proponent time')).getAllByRole('listitem')).toHaveLength(105);
    expect(screen.queryByRole('button', { name: /Show \d+ more/ })).not.toBeInTheDocument();
  });
});
