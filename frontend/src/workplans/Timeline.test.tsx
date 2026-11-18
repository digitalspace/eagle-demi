import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FIXTURE from '../../parity/fixtures/workplans.json';
import type { WorkplanRow } from '../api/sheet-works';
import { rowsOf } from './derive';
import { TimelineView } from './Timeline';

const TODAY = '2026-11-17';
const LEFT_PX = 368;
const LANE_PX = 1000;

// JSDOM lays nothing out; give the scroll box and the sticky left columns a width so the lane is measured.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('timeline__scroll') ? LEFT_PX + LANE_PX : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('timeline__left--head') ? LEFT_PX : 0;
  });
});
afterEach(() => vi.restoreAllMocks());

/** Today's line, in px from the left edge of the visible lane. */
function todayInLane(region: HTMLElement): number {
  const scroller = region.querySelector<HTMLElement>('.timeline__scroll')!;
  const line = region.querySelector<HTMLElement>('.timeline__today-line')!;
  const x = Number(/\+ ([\d.]+)px/.exec(line.style.left)![1]);
  return Math.round(x - scroller.scrollLeft);
}

describe('TimelineView', () => {
  it('keeps today a quarter of the way into the lane after a zoom change', async () => {
    render(
      <MemoryRouter>
        <TimelineView rows={rowsOf(FIXTURE.works as WorkplanRow[], [], TODAY)} today={TODAY} />
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    const region = screen.getByRole('region', { name: 'Timeline' });
    await user.click(screen.getByRole('button', { name: 'Month' }));

    expect(screen.getByRole('button', { name: 'Month' })).toHaveAttribute('aria-pressed', 'true');
    expect(todayInLane(region)).toBe(LANE_PX * 0.25);
  });
});
