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
const WORKS = FIXTURE.works as WorkplanRow[];
const rows = (works: WorkplanRow[] = WORKS) => rowsOf(works, [], TODAY);
const panel = (act: number) => screen.getByRole('region', { name: `${act} Act timeline` });
/** The group whose head names `label`. */
const groupOf = (scope: HTMLElement, label: string) =>
  within(scope).getByText(label, { selector: '.timeline__group-name' }).closest<HTMLElement>('.timeline__group')!;
const bottomTicks = (group: HTMLElement) =>
  [...group.querySelectorAll('.timeline__tier--bottom .timeline__tick')].map((tick) => tick.textContent).filter(Boolean);

/** Today's line, in px from the left edge of the visible lane of `group`. */
function todayInLane(group: HTMLElement): number {
  const scroller = group.querySelector<HTMLElement>('.timeline__scroll')!;
  const line = group.querySelector<HTMLElement>('.timeline__today-line')!;
  const x = Number(/\+ ([\d.]+)px/.exec(line.style.left)![1]);
  return Math.round(x - scroller.scrollLeft);
}

function renderView(works?: WorkplanRow[]) {
  return render(
    <MemoryRouter>
      <TimelineView rows={rows(works)} today={TODAY} />
    </MemoryRouter>,
  );
}

describe('TimelineView', () => {
  it('draws one timeline per Act, newest first, with a jump link to each', () => {
    renderView();

    const heads = [...document.querySelectorAll('.timeline__act-head .timeline__act-name')].map((head) => head.textContent);
    expect(heads).toEqual(['2018 Act', '2002 Act', '1996 Act']);
    const links = within(screen.getByRole('navigation', { name: 'Acts' })).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['2018 Act 5 works', '2002 Act 8 works', '1996 Act 3 works']);
  });

  it('shows only the one Act a narrowed list holds, with no empty panels and no jump strip', () => {
    renderView(WORKS.filter((work) => work.actYear === 2018));

    const heads = [...document.querySelectorAll('.timeline__act-name')].map((head) => head.textContent);
    expect(heads).toEqual(['2018 Act']);
    expect(screen.queryByRole('navigation', { name: 'Acts' })).toBeNull();
  });

  it('switches a panel at Fit all to Quarter when Today is pressed', async () => {
    renderView();
    const user = userEvent.setup();
    await user.click(within(panel(2018)).getByRole('button', { name: 'Fit all' }));

    await user.click(within(panel(2018)).getByRole('button', { name: 'Today' }));

    expect(within(panel(2018)).getByRole('button', { name: 'Quarter' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps today a quarter of the way into the lane after a zoom change', async () => {
    renderView();
    const user = userEvent.setup();
    await user.click(within(panel(2018)).getByRole('button', { name: 'Month' }));

    expect(within(panel(2018)).getByRole('button', { name: 'Month' })).toHaveAttribute('aria-pressed', 'true');
    expect(todayInLane(groupOf(panel(2018), 'Sample Beta Quarry'))).toBe(LANE_PX * 0.25);
  });

  it('groups by project by default, each block on an axis that fits that project’s works in that Act', () => {
    renderView();

    expect(within(panel(2002)).getByRole('button', { name: 'Project' })).toHaveAttribute('aria-pressed', 'true');
    const alpha = groupOf(panel(2002), 'Sample Alpha Transmission Line');
    expect(alpha.querySelector('summary')).toHaveTextContent('2003 to 2014');
    const ticks = bottomTicks(alpha);
    expect([ticks[0], ticks.at(-1)]).toEqual(['2003', '2014']);
  });

  it('gives each work-type group its own axis', async () => {
    const delta = WORKS.find((work) => work.title === 'Sample Delta Pipeline - Assessment (1996)')!;
    const amendment = {
      ...delta,
      workId: 'sheet-amendment-1996',
      title: 'Sample Delta Pipeline - Amendment (1996)',
      workTypeCode: 'amendment',
      startDate: '2024-01-01',
      decisionDate: '2025-07-23',
      phases: [{ ...delta.phases[0], startDate: '2024-01-01', endDate: '2025-07-23' }],
    };
    renderView([...WORKS, amendment]);

    await userEvent.setup().click(within(panel(1996)).getByRole('button', { name: 'Work type' }));

    const assessment = groupOf(panel(1996), 'Assessment');
    expect(assessment.querySelector('summary')).toHaveTextContent('1995 to 2003');
    expect(bottomTicks(assessment)).not.toContain('2024');
    const amendments = groupOf(panel(1996), 'Amendment');
    expect(amendments.querySelector('summary')).toHaveTextContent('2024 to 2025');
    expect(bottomTicks(amendments)).not.toContain('2003');
  });

  it('starts a panel of more than 12 groups folded, with no rows mounted, and opens them once 12 or fewer are left', async () => {
    const extension = WORKS.find((work) => work.workTypeCode === 'eac-extension')!;
    const projects = Array.from({ length: 13 }, (_, i) => ({
      ...extension,
      workId: `track-fold-${i}`,
      projectId: `fold-${i}`,
      projectName: `Project ${String(i + 1).padStart(2, '0')}`,
    }));
    const user = userEvent.setup();
    const { rerender } = renderView(projects);
    const shown = () => [...document.querySelectorAll<HTMLElement>('li.timeline__row')];
    expect(shown()).toHaveLength(0);

    await user.click(within(panel(2002)).getByText('Project 01'));
    await waitFor(() => expect(shown()).toHaveLength(1));
    rerender(
      <MemoryRouter>
        <TimelineView rows={rows(projects.slice(0, 12))} today={TODAY} />
      </MemoryRouter>,
    );
    expect(shown()).toHaveLength(12);
    await user.click(within(panel(2002)).getByText('Project 02'));
    await waitFor(() => expect(shown()).toHaveLength(11));

    // Back over 12: the block the reader opened stays open, the one they folded stays folded.
    rerender(
      <MemoryRouter>
        <TimelineView rows={rows(projects)} today={TODAY} />
      </MemoryRouter>,
    );
    expect(shown()).toHaveLength(1);
    expect(groupOf(panel(2002), 'Project 01')).toHaveAttribute('open');
  });

  it('moves focus to the other part of a work that switched Act, opening its panel', async () => {
    renderView();
    const user = userEvent.setup();
    await user.click(screen.getByText('2002 Act', { selector: '.timeline__act-name' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: '2002 Act timeline' })).toBeNull());

    await user.click(within(panel(1996)).getByRole('button', { name: 'To 2002 Act, 30 Apr 2003' }));

    expect(within(panel(2002)).getByRole('link', { name: 'Sample Alpha Transmission Line - Assessment (2002)' })).toHaveFocus();
  });

  it('pans the lane a quarter at a time from the overview window, which Fit all hides', async () => {
    renderView();
    const user = userEvent.setup();
    const [slider] = within(panel(2018)).getAllByRole('slider', { name: 'Visible range' });
    const scroller = slider.closest('.timeline__group')!.querySelector<HTMLElement>('.timeline__scroll')!;
    const before = scroller.scrollLeft;

    slider.focus();
    await user.keyboard('{ArrowLeft}');

    // Quarter zoom shows three years across the lane, so a quarter is a twelfth of it.
    expect(scroller.scrollLeft).toBe(Math.round(before - LANE_PX / 12));
    expect(slider).toHaveAttribute('aria-valuenow', String(scroller.scrollLeft));
    await user.click(within(panel(2018)).getByRole('button', { name: 'Fit all' }));
    expect(within(panel(2018)).queryByRole('slider', { name: 'Visible range' })).toBeNull();
  });

  it('names an overdue bar’s overrun on hover', () => {
    renderView();

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
    const details = screen.getByRole('region', { name: `${ALPHA_1996}, 1996 Act` });
    expect(toggle).toHaveAttribute('aria-controls', details.id);
    expect(await within(details).findByText('Section 11 Order')).toBeInTheDocument();
    expect(within(details).getByText('Withdrawn · Moved to the 2002 Act')).toBeInTheDocument();
  });

  it('keeps a work’s details open when its group folds and unfolds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => (String(input).includes('/sheet-works') ? json(SHEET) : json({}))),
    );
    renderScreen(<TimelineView rows={rows()} today={TODAY} />);
    const user = userEvent.setup();
    const details = () => screen.queryByRole('region', { name: `${ALPHA_1996}, 1996 Act` });
    await user.click(screen.getByRole('button', { name: `Details for ${ALPHA_1996}` }));
    const group = within(panel(1996)).getByText('Sample Alpha Transmission Line');

    await user.click(group);
    await waitFor(() => expect(details()).toBeNull());
    await user.click(group);

    await waitFor(() => expect(details()).toBeInTheDocument());
    expect(screen.getByRole('button', { name: `Details for ${ALPHA_1996}` })).toHaveAttribute('aria-expanded', 'true');
  });

  it('tells screen readers how a closed work ended and when', () => {
    renderView();

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
