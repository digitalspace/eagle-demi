import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FIXTURE from '../../parity/fixtures/workplans.json';
import type { WorkplanRow } from '../api/sheet-works';
import { stubResizeObserver } from './__tests__/dom';
import { phaseOf, workOf } from './__tests__/works';
import { Overview } from './Overview';

vi.mock('../config', async (load) => ({
  ...(await load<typeof import('../config')>()),
  config: () => ({ EAGLE_ADMIN_URL: 'https://admin.example.invalid/admin/' }),
}));

const TODAY = '2026-11-17';
const FIXTURE_WORKS = FIXTURE.works as unknown as WorkplanRow[];

/** Over its 30-day legal limit since early 2026, with a planned decision that has passed. */
const ZETA = workOf(
  [
    phaseOf('Early Engagement', '2026-01-01', '2026-03-01', { order: 1, isCompleted: true }),
    phaseOf('Process Planning', '2026-03-02', null, { order: 2, isCurrent: true, numberOfDays: 30, legislated: true }),
  ],
  { startDate: '2026-01-01', decisionEventDate: '2026-10-01' },
);

function renderOverview(works: readonly WorkplanRow[]) {
  render(
    <MemoryRouter initialEntries={['/workplans']}>
      <Overview works={works} today={TODAY} />
    </MemoryRouter>,
  );
  return userEvent.setup();
}

const rowNames = () => screen.getAllByRole('link', { name: /^Open / }).map((link) => link.getAttribute('title'));
const marksOf = (year: number) => within(screen.getByRole('region', { name: new RegExp(`^${year} Act timeline`) })).getAllByRole('button');

beforeEach(() => {
  stubResizeObserver();
  // jsdom has neither; the row keys and hover only need them to exist.
  Element.prototype.scrollIntoView = () => undefined;
  document.elementsFromPoint = () => [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  Reflect.deleteProperty(document, 'elementsFromPoint');
});

describe('Overview', () => {
  it('draws one section per Act, newest Act first', () => {
    renderOverview(FIXTURE_WORKS);

    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['2018 Act', '2002 Act', '1996 Act']);
  });

  it('drops the rows of a work type once its toggle is off', async () => {
    const user = renderOverview(FIXTURE_WORKS);
    const quarry2018 = { name: /^Open Sample Beta Quarry, ID 902, 2018 Act/ };
    expect(screen.getByRole('link', quarry2018)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Amendments' }));

    expect(screen.getByRole('button', { name: 'Amendments' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('link', quarry2018)).toBeNull();
    expect(screen.getByRole('link', { name: /^Open Sample Alpha Transmission Line, ID 901, 2018 Act/ })).toBeInTheDocument();
  });

  it('keeps only rows over a legal time limit when Over a time limit is checked', async () => {
    const user = renderOverview([...FIXTURE_WORKS, ZETA]);
    expect(rowNames().length).toBeGreaterThan(1);

    await user.click(screen.getByRole('checkbox', { name: /Over a time limit/ }));

    expect(rowNames()).toEqual(['Sample Zeta Mine']);
  });

  it('opens and closes the legend from its button, with its five group headings', async () => {
    const user = renderOverview(FIXTURE_WORKS);
    const button = screen.getByRole('button', { name: 'Legend' });
    expect(button).toHaveAttribute('aria-expanded', 'false');

    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Phase colours',
      'Bars',
      'Other Acts',
      'Markers',
      'Calendar lines',
    ]);

    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('heading', { name: 'Markers' })).toBeNull();
  });

  it('tags a row over its limit and past its planned decision', () => {
    renderOverview([ZETA]);

    const row = screen.getByRole('link', { name: /^Open Sample Zeta Mine/ }).closest('.wp-ov-nc') as HTMLElement;
    expect(within(row).getByText('230 days over limit')).toBeInTheDocument();
    expect(within(row).getByText('Decision overdue')).toBeInTheDocument();
  });
});

describe('Overview mark popups', () => {
  it('links a dated phase to its eagle-admin documents in a new tab, and says so in the mark name', async () => {
    const user = renderOverview([ZETA]);
    const mark = screen.getByRole('button', { name: /^Phase: Assessment\. Phase Early Engagement\./ });
    expect(mark).toHaveAccessibleName(expect.stringMatching(/Select for the link "Find phase documents"\.$/));

    await user.click(mark);

    // dom-accessibility-api drops the hidden span's leading space that browsers keep.
    const link = within(screen.getByRole('tooltip')).getByRole('link', { name: /^Find phase documents\s?\(opens in a new tab\)$/ });
    expect(link).toHaveAttribute(
      'href',
      'https://admin.example.invalid/admin/p/e950/project-documents;datePostedStart=2026-01-01;datePostedEnd=2026-03-01',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('links an overdue decision to the project record inside the app', async () => {
    const user = renderOverview([ZETA]);

    await user.click(screen.getByRole('button', { name: /^Overdue decision: Assessment\./ }));

    const link = within(screen.getByRole('tooltip')).getByRole('link', { name: 'View workplan' });
    expect(link).toHaveAttribute('href', '/workplans/950?act=2018');
    expect(link).not.toHaveAttribute('target');
  });

  it('names no link for a mark whose popup draws none', async () => {
    const user = renderOverview([ZETA]);
    const arrow = screen.getByRole('button', { name: /^No recorded end date: Assessment\./ });
    expect(arrow).not.toHaveAccessibleName(expect.stringContaining('Select for the link'));

    await user.click(arrow);
    expect(within(screen.getByRole('tooltip')).queryByRole('link')).toBeNull();
  });
});

describe('Overview hover', () => {
  const box = (left: number, width: number) => ({ left, right: left + width, top: 0, bottom: 20, width, height: 20, x: left, y: 0 }) as DOMRect;

  it('shows the narrow mark near the pointer rather than the wide bar under it', () => {
    renderOverview([ZETA]);
    const bar = screen.getByRole('button', { name: /^Phase: Assessment\. Phase Early Engagement\./ });
    const decision = screen.getByRole('button', { name: /^Overdue decision: Assessment\./ });
    vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue(box(0, 200));
    vi.spyOn(decision, 'getBoundingClientRect').mockReturnValue(box(100, 6));
    document.elementsFromPoint = () => [bar, decision];

    // fireEvent: the hit test reads these exact pointer coordinates.
    fireEvent.mouseMove(bar, { clientX: 110, clientY: 10 });

    expect(within(screen.getByRole('tooltip')).getByText('Overdue decision')).toBeInTheDocument();
  });
});

describe('Overview row keys', () => {
  it('gives each row one tab stop, which follows the arrow, Home and End keys', async () => {
    const user = renderOverview([ZETA]);
    const marks = marksOf(2018);
    const stops = () => marks.filter((mark) => mark.tabIndex === 0);
    expect(marks.length).toBeGreaterThan(2);
    expect(stops()).toHaveLength(1);

    act(() => marks[0].focus());
    await user.keyboard('{ArrowRight}');
    expect(marks[1]).toHaveFocus();
    await user.keyboard('{End}');
    expect(marks.at(-1)).toHaveFocus();
    await user.keyboard('{Home}');
    expect(marks[0]).toHaveFocus();
    expect(stops()).toEqual([marks[0]]);
  });

  it('pins the popup on Enter and moves focus to its link; Escape closes it and returns focus to the mark', async () => {
    const user = renderOverview([ZETA]);
    const mark = screen.getByRole('button', { name: /^Overdue decision: Assessment\./ });

    act(() => mark.focus());
    await user.keyboard('{Enter}');
    expect(within(screen.getByRole('tooltip')).getByRole('link', { name: 'View workplan' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(mark).toHaveFocus();
  });

  it('closes a pinned popup on a press outside it', async () => {
    const user = renderOverview([ZETA]);
    await user.click(screen.getByRole('button', { name: /^Phase: Assessment\. Phase Early Engagement\./ }));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    await user.click(screen.getByText('All works by Act. Select a project to open its record.'));

    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
