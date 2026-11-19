import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import FIXTURE from '../../parity/fixtures/workplans.json';
import type { WorkplanRow } from '../api/sheet-works';
import { rowKey, rowsOf, type WorkRow } from './derive';
import { transitionPairsOf } from './timeline-markers';
import { groupsOf, type Group } from './timeline-rows';
import { scaleFor, type Zoom } from './timeline-scale';
import { TimelineGroup } from './TimelineGroup';
import { TimelineRow } from './TimelineRow';

const TODAY = '2026-11-17';
const WORKS = FIXTURE.works as WorkplanRow[];
const ROWS = rowsOf(WORKS, [], TODAY);
const byTitle = (title: string) => ROWS.find((row) => row.work.title === title)!;
const ALPHA_1996 = byTitle('Sample Alpha Transmission Line - Assessment (1996)');

const inRouter = (children: ReactNode) => render(<MemoryRouter>{children}</MemoryRouter>);

function renderRow(row: WorkRow, partner?: string, onJump = vi.fn()) {
  const scale = scaleFor({ start: 9000, end: 13000 }, 'fit', TODAY, 1000);
  inRouter(
    <ul>
      <TimelineRow row={row} scale={scale} today={TODAY} open={false} follow={false} toggle={vi.fn()} unfollow={vi.fn()} partner={partner} onJump={onJump} />
    </ul>,
  );
  return onJump;
}

function renderGroup(rows: WorkRow[], zoom: Zoom) {
  const group: Group = { key: 'g', label: 'Group', rows, overdue: 0 };
  return inRouter(
    <TimelineGroup
      group={group}
      open
      onToggle={vi.fn()}
      zoom={zoom}
      today={TODAY}
      opened={{ open: new Set(), follow: null }}
      onDetails={vi.fn()}
      unfollow={vi.fn()}
      onJump={vi.fn()}
      pairs={new Map()}
      toToday={0}
    />,
  );
}

describe('TimelineRow', () => {
  it('a switched work’s marker calls onJump with its other part', async () => {
    const partner = transitionPairsOf(ROWS).get(rowKey(ALPHA_1996));
    const onJump = renderRow(ALPHA_1996, partner);

    await userEvent.setup().click(screen.getByRole('button', { name: 'To 2002 Act, 30 Apr 2003' }));

    expect(onJump).toHaveBeenCalledWith(rowKey(byTitle('Sample Alpha Transmission Line - Assessment (2002)')));
  });

  it('shows the Act switch as text when its other part is not shown', () => {
    renderRow(ALPHA_1996);

    expect(screen.getByText('To 2002 Act, 30 Apr 2003')).not.toHaveRole('button');
  });

  it('a work with no full phase says what is known', () => {
    const gamma = byTitle('sample gamma wind farm - Assessment (1996)').work;
    const undrawn = { ...gamma, phases: gamma.phases.map((phase) => ({ ...phase, endDate: null })) };

    renderRow(rowsOf([undrawn], [], TODAY)[0]);

    expect(screen.getByText('Decision 27 Apr 1998. Phase dates not known.')).toBeInTheDocument();
  });
});

describe('TimelineGroup', () => {
  /** A copy of the closed Delta 2002 extension, decided in March this year, so a Year axis runs past today. */
  const closedThisYear = () => {
    const extension = WORKS.find((work) => work.title === 'Sample Delta Pipeline - EAC Extension')!;
    return rowsOf([{ ...extension, decisionDate: '2026-03-01' }], [], TODAY);
  };

  it('a group of closed works draws no today line, though its axis reaches today', () => {
    const rows = closedThisYear();
    expect(rows[0].closed).toBe(true);
    const { container, unmount } = renderGroup(rows, 'year');
    expect(container.querySelector('.timeline__tick')).not.toBeNull();
    expect(container.querySelector('.timeline__today-line')).toBeNull();
    unmount();

    const { container: open } = renderGroup([byTitle('Sample Beta Quarry - Amendment')], 'year');
    expect(open.querySelector('.timeline__today-line')).not.toBeNull();
  });

  it('marks today on the overview of a group still running, not on a closed group whose axis ends before today', () => {
    const act2002 = groupsOf(ROWS, 'act', TODAY).find((group) => group.key === 'act-2002')!;
    const alpha = groupsOf(act2002.rows, 'project', TODAY).find((group) => group.label === 'Sample Alpha Transmission Line')!;
    const { container, unmount } = renderGroup(alpha.rows, 'quarter');
    expect(container.querySelector('.timeline__overview')).not.toBeNull();
    expect(container.querySelector('.timeline__overview-today')).toBeNull();
    unmount();

    const open = renderGroup(groupsOf(ROWS, 'act', TODAY)[0].rows, 'month');
    expect(open.container.querySelector('.timeline__overview-today')).not.toBeNull();
  });
});
