import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FIXTURE from '../../parity/fixtures/workplans.json';
import SHEET from '../../parity/fixtures/projects-901-sheet-works.json';
import type { WorkplanRow } from '../api/sheet-works';
import { json } from '../test-http';
import { renderScreen } from '../test-query';
import { rowsOf } from './derive';
import { TimelineView } from './Timeline';
import { Legend } from './timeline-parts';

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
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ALPHA_1996 = 'Sample Alpha Transmission Line - Assessment (1996)';
const rows = () => rowsOf(FIXTURE.works as WorkplanRow[], [], TODAY);

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
        <TimelineView rows={rows()} today={TODAY} />
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    const region = screen.getByRole('region', { name: 'Timeline' });
    await user.click(screen.getByRole('button', { name: 'Month' }));

    expect(screen.getByRole('button', { name: 'Month' })).toHaveAttribute('aria-pressed', 'true');
    expect(todayInLane(region)).toBe(LANE_PX * 0.25);
  });

  it('pans the lane a quarter at a time from the overview window, which Fit all hides', async () => {
    render(
      <MemoryRouter>
        <TimelineView rows={rows()} today={TODAY} />
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    const scroller = screen.getByRole('region', { name: 'Timeline' }).querySelector<HTMLElement>('.timeline__scroll')!;
    const slider = screen.getByRole('slider', { name: 'Visible range' });
    const before = scroller.scrollLeft;

    slider.focus();
    await user.keyboard('{ArrowLeft}');

    // Quarter zoom shows three years across the lane, so a quarter is a twelfth of it.
    expect(scroller.scrollLeft).toBe(Math.round(before - LANE_PX / 12));
    expect(slider).toHaveAttribute('aria-valuenow', String(scroller.scrollLeft));
    await user.click(screen.getByRole('button', { name: 'Fit all' }));
    expect(screen.queryByRole('slider', { name: 'Visible range' })).toBeNull();
  });

  it('names an overdue bar’s overrun on hover', () => {
    render(
      <MemoryRouter>
        <TimelineView rows={rows()} today={TODAY} />
      </MemoryRouter>,
    );

    expect(screen.getByTitle(/^\d+ days overdue$/)).toHaveClass('timeline__bar--overrun');
  });

  it('opens a 1996 work’s stored milestones and outcome under its row', async () => {
    // The fixture's 1996 work has no milestones; give it one so the panel has one to show.
    const sheet = {
      works: SHEET.works.map((work) =>
        work.actYear === 1996
          ? {
              ...work,
              milestones: [{ ...SHEET.works[1].milestones[0], name: 'Section 11 Order' }],
            }
          : work,
      ),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => (String(input).includes('/sheet-works') ? json(sheet) : json({}))),
    );
    renderScreen(<TimelineView rows={rows()} today={TODAY} />);
    const toggle = screen.getByRole('button', {
      name: `Details for ${ALPHA_1996}`,
    });

    await userEvent.setup().click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = screen.getByRole('region', { name: `${ALPHA_1996}, 1996 Act` });
    expect(toggle).toHaveAttribute('aria-controls', panel.id);
    expect(await within(panel).findByText('Section 11 Order')).toBeInTheDocument();
    expect(within(panel).getByText('Withdrawn · Moved to the 2002 Act')).toBeInTheDocument();
  });

  it('keeps a work’s details open when its group folds and unfolds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => (String(input).includes('/sheet-works') ? json(SHEET) : json({}))),
    );
    renderScreen(<TimelineView rows={rows()} today={TODAY} />);
    const user = userEvent.setup();
    const panel = () => screen.queryByRole('region', { name: `${ALPHA_1996}, 1996 Act` });
    await user.click(screen.getByRole('button', { name: `Details for ${ALPHA_1996}` }));
    const group = screen.getByText('1996 Act');

    await user.click(group);
    await waitFor(() => expect(panel()).toBeNull());
    await user.click(group);

    await waitFor(() => expect(panel()).toBeInTheDocument());
    expect(screen.getByRole('button', { name: `Details for ${ALPHA_1996}` })).toHaveAttribute('aria-expanded', 'true');
  });

  it('tells screen readers how a closed work ended and when', () => {
    render(
      <MemoryRouter>
        <TimelineView rows={rows()} today={TODAY} />
      </MemoryRouter>,
    );

    expect(screen.getByText(/^Closed\. Certificate Issued \(PAC\), decision 10 Jun 1999\. /)).toBeInTheDocument();
  });
});

describe('Legend', () => {
  it('keys Not completed only while some bar draws it', () => {
    const { rerender } = render(<Legend drawn={new Set()} />);
    expect(screen.queryByText('Not completed')).toBeNull();

    rerender(<Legend drawn={new Set(['incomplete'])} />);
    expect(within(screen.getByRole('list', { name: 'Legend' })).getByText('Not completed')).toBeInTheDocument();
  });
});
