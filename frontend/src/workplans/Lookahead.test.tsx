import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import FIXTURE from '../../parity/fixtures/workplans.json';
import type { WorkplanRow } from '../api/sheet-works';
import { rowsOf } from './derive';
import { LookaheadView } from './Lookahead';

const TODAY = '2026-11-17';
const WORKS = FIXTURE.works as WorkplanRow[];

function renderLookahead(works = WORKS) {
  render(
    <MemoryRouter>
      <LookaheadView rows={rowsOf(works, [], TODAY)} today={TODAY} />
    </MemoryRouter>,
  );
  return userEvent.setup();
}

const byId = (workId: string) => WORKS.find((work) => work.workId === workId)!;
const region = (name: RegExp) => screen.getByRole('region', { name });

describe('LookaheadView', () => {
  it('counts milestones and works in the summary, with the date range', () => {
    renderLookahead();
    expect(screen.getByRole('status')).toHaveTextContent(/^3 milestones across 3 works, 17 Nov 2026 to 15 Feb 2027$/);
  });

  it('uses the singular for one milestone on one work', () => {
    renderLookahead([byId('track-9401')]);
    expect(screen.getByRole('status')).toHaveTextContent(/^1 milestone across 1 work,/);
  });

  it('counts down to each agenda item, a start due today reading "today"', () => {
    const gamma = byId('track-9401');
    const startsToday: WorkplanRow = {
      ...gamma,
      phases: gamma.phases.map((phase, i) => (i === 0 ? { ...phase, startDate: `${TODAY}T08:00:00.000Z` } : phase)),
    };
    renderLookahead([byId('track-9101'), startsToday]);
    expect(within(region(/^16 Nov – 22 Nov This week/)).getByText('today')).toBeInTheDocument();
    expect(within(region(/^30 Nov – 6 Dec/)).getByText('in 14 d')).toBeInTheDocument();
  });

  it('shows 8 overdue works, then moves focus to the first one Show more reveals', async () => {
    const alpha = byId('track-9101');
    const overdue = Array.from({ length: 12 }, (_, i) => ({
      ...alpha,
      workId: `copy-${i}`,
      title: `Overdue copy ${String(i).padStart(2, '0')}`,
    }));
    const user = renderLookahead(overdue);
    const panel = region(/^Overdue now/);
    expect(within(panel).getAllByRole('listitem')).toHaveLength(8);

    await user.click(within(panel).getByRole('button', { name: 'Show 4 more' }));

    expect(within(panel).getAllByRole('listitem')).toHaveLength(12);
    expect(within(panel).getByRole('link', { name: 'Overdue copy 08' })).toHaveFocus();
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
