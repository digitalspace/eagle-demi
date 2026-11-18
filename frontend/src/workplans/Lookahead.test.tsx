import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import FIXTURE from '../../parity/fixtures/workplans.json';
import type { WorkplanRow } from '../api/sheet-works';
import { rowsOf } from './derive';
import type { BarSlot } from './Filters';
import { LookaheadView } from './Lookahead';

const TODAY = '2026-11-17';
const WORKS = FIXTURE.works as WorkplanRow[];
// Stands in for the shared filter bar, which shows the view's lead controls and summary.
const bar: BarSlot = (slots) => (
  <div>
    {slots?.lead}
    {slots?.chips}
    <output>{slots?.summary}</output>
  </div>
);

function renderLookahead(works = WORKS) {
  render(
    <MemoryRouter>
      <LookaheadView rows={rowsOf(works, [], TODAY)} today={TODAY} bar={bar} />
    </MemoryRouter>,
  );
  return userEvent.setup();
}

const byId = (workId: string) => WORKS.find((work) => work.workId === workId)!;
const region = (name: RegExp) => screen.getByRole('region', { name });

describe('LookaheadView', () => {
  it('counts milestones and works in the summary, with the date range', () => {
    renderLookahead();
    expect(screen.getByRole('status')).toHaveTextContent(/^3 milestones across 3 works · Nov 17 – Feb 15, 2027$/);
  });

  it('uses the singular for one milestone on one work', () => {
    renderLookahead([byId('track-9401')]);
    expect(screen.getByRole('status')).toHaveTextContent(/^1 milestone across 1 work ·/);
  });

  it('counts down to each agenda item, a start due today reading "today"', () => {
    const gamma = byId('track-9401');
    const startsToday: WorkplanRow = {
      ...gamma,
      phases: gamma.phases.map((phase, i) => (i === 0 ? { ...phase, startDate: `${TODAY}T08:00:00.000Z` } : phase)),
    };
    renderLookahead([byId('track-9101'), startsToday]);
    expect(within(region(/^Week of Nov 16/)).getByText('today')).toBeInTheDocument();
    expect(within(region(/^Week of Nov 30/)).getByText('in 14 d')).toBeInTheDocument();
  });

  it('lists every overdue work, with no cap', () => {
    const alpha = byId('track-9101');
    const overdue = Array.from({ length: 12 }, (_, i) => ({ ...alpha, workId: `copy-${i}`, title: `Overdue copy ${i}` }));
    renderLookahead(overdue);

    expect(within(region(/^Overdue now/)).getAllByRole('link')).toHaveLength(12);
  });

  it('names each week button with its counts, and a click moves focus to that week', async () => {
    const user = renderLookahead();
    const weeks = screen.getByRole('list', { name: 'Milestones per week' });

    await user.click(within(weeks).getByRole('button', { name: 'Week of Nov 30: 1 milestone' }));

    expect(screen.getByRole('heading', { name: /^Week of Nov 30/ })).toHaveFocus();
  });

  it('narrows the agenda to one milestone type, while the decisions panel keeps every decision', async () => {
    const user = renderLookahead();
    await user.click(screen.getByRole('button', { name: '6 months' }));

    await user.selectOptions(screen.getByRole('combobox', { name: 'Milestone type' }), 'Phase start');

    expect(screen.getByRole('status')).toHaveTextContent(/^4 milestones across 3 works ·/);
    expect(within(region(/^Upcoming milestones$/)).queryByText('Amendment Review → Decision')).not.toBeInTheDocument();
    expect(within(region(/^Decisions this window$/)).getByText('Decision due')).toBeInTheDocument();
  });

  it('says when the window holds no milestones, and drops the longer-window hint at 6 months', async () => {
    const user = renderLookahead([byId('track-9501')]);
    const main = region(/^Upcoming milestones$/);
    expect(
      within(main).getByText('No milestones in the next 90 days. Choose a longer window to look further ahead.'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '6 months' }));

    expect(within(main).getByText('No milestones in the next 6 months.')).toBeInTheDocument();
  });
});
