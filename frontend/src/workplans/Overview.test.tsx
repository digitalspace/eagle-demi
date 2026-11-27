import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
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

function renderOverview(works: readonly WorkplanRow[], path = '/workplans') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Overview works={works} today={TODAY} />
      <SearchProbe />
    </MemoryRouter>,
  );
  return userEvent.setup();
}

function SearchProbe() {
  return <output aria-label="Address search">{useLocation().search}</output>;
}

const addressParams = () => new URLSearchParams(screen.getByRole('status', { name: 'Address search' }).textContent ?? '');

/** ZETA's project, with an amendment of its own. */
const ZETA_AMENDMENT = workOf([phaseOf('Amendment Review', '2026-04-01', '2026-06-30', { isCompleted: true })], {
  workId: 'track-950-amd',
  workTypeCode: 'amendment',
  workType: 'Amendment',
  title: 'Sample Zeta Mine - Tailings Amendment',
  workState: 'COMPLETED',
  isActive: false,
});

/** Two staffed Track works on two teams, and a sheet work with no one on it. */
const STAFFED = [
  { ...ZETA, team: 'Team A', staff: [{ name: 'Staff One', role: 'Work lead' }] },
  workOf([phaseOf('Early Engagement', '2026-02-01', null, { isCurrent: true })], {
    projectId: '951',
    projectName: 'Sample Eta Dam',
    workId: 'track-951',
    title: 'Sample Eta Dam - Assessment',
    team: 'Team B',
    staff: [{ name: 'Staff Two', role: 'Responsible EPD' }],
  }),
  workOf([phaseOf('Application Review', '2005-01-01', '2005-06-30', { isCompleted: true })], {
    projectId: '952',
    projectName: 'Sample Iota Mill',
    workId: 'sheet-952',
    source: 'sheet',
    actYear: 2002,
    workState: 'completed',
    isActive: false,
    title: 'Sample Iota Mill - Assessment (2002)',
  }),
];

const rowNames = () => screen.getAllByRole('link', { name: /^Open / }).map((link) => link.getAttribute('title'));

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

  it('tags the assessment over its limit and past its planned decision, on the project line it shares', () => {
    renderOverview([ZETA]);

    const row = screen.getByRole('link', { name: /^Open Sample Zeta Mine/ }).closest('.wp-ov-nc') as HTMLElement;
    expect(within(row).getByText('Assessment')).toBeInTheDocument();
    expect(within(row).getByText('230 days over limit')).toBeInTheDocument();
    expect(within(row).getByText('Decision overdue')).toBeInTheDocument();
  });

  it('sorts by Start date first', () => {
    renderOverview(FIXTURE_WORKS);

    expect(screen.getByRole('combobox', { name: 'Sort by' })).toHaveDisplayValue('Start date');
  });

  it('says which Act has no dates in the year picked', async () => {
    const theta = workOf([phaseOf('Application Review', '1998-03-01', '2000-06-30', { isCompleted: true })], {
      projectId: '953',
      projectName: 'Sample Theta Road',
      workId: 'sheet-953',
      source: 'sheet',
      actYear: 1996,
      workState: 'completed',
      isActive: false,
      title: 'Sample Theta Road - Assessment (1996)',
    });
    const user = renderOverview([ZETA, theta]);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Go to year' }), '2026');

    const nav = within(screen.getByRole('navigation', { name: 'Navigate the timeline' }));
    await waitFor(() => expect(nav.getByRole('status')).toHaveTextContent('No dates in 2026 under the 1996 Act (1998 to 2000)'));
  });
});

describe('Overview Assigned to and Team', () => {
  it('opens with the person and team in the address and says how many sheet works they hide', () => {
    renderOverview(STAFFED, '/workplans?who=Staff%20One&team=Team%20A');

    expect(screen.getByRole('combobox', { name: 'Assigned to' })).toHaveDisplayValue('Staff One');
    expect(screen.getByRole('combobox', { name: 'Team' })).toHaveDisplayValue('Team A');
    expect(rowNames()).toEqual(['Sample Zeta Mine']);
    expect(screen.getByText('1 sheet work has no one assigned in Track and is hidden by these filters.')).toBeInTheDocument();
  });

  it('keeps offering a person named in the address who is on no work, so the select shows who filters the rows', () => {
    renderOverview(STAFFED, '/workplans?who=Staff%20Nine');

    expect(screen.getByRole('combobox', { name: 'Assigned to' })).toHaveDisplayValue('Staff Nine');
    expect(screen.queryAllByRole('link', { name: /^Open / })).toEqual([]);
  });

  it('keeps the hidden sheet works note in one live region, so a filter change is announced', async () => {
    const user = renderOverview(STAFFED, '/workplans?team=Team%20A');
    const note = screen.getByText('1 sheet work has no one assigned in Track and is hidden by these filters.');
    expect(note).toHaveAttribute('aria-live', 'polite');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Team' }), '');

    expect(note).toBeInTheDocument();
    expect(note).toHaveTextContent('');
  });

  it('keeps a picked team and person in the address and shows only their works', async () => {
    const user = renderOverview(STAFFED);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Team' }), 'Team B');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Assigned to' }), 'Staff Two');

    expect(rowNames()).toEqual(['Sample Eta Dam']);
    expect([addressParams().get('team'), addressParams().get('who')]).toEqual(['Team B', 'Staff Two']);
  });
});

describe('Overview Act title', () => {
  /** ZETA's project under the 2002 Act too, so each row carries a jump link to the other. */
  const ZETA_2002 = workOf([phaseOf('Application Review', '2005-01-01', '2005-06-30', { isCompleted: true })], {
    workId: 'sheet-950-2002',
    source: 'sheet',
    actYear: 2002,
    workState: 'completed',
    isActive: false,
    title: 'Sample Zeta Mine - Assessment (2002)',
  });

  it('minimizes the Act so its rows leave the page, and brings them back on a second press', async () => {
    const user = renderOverview([ZETA]);
    const title = screen.getByRole('button', { name: '2018 Act' });

    await user.click(title);

    expect(title).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: /^Open Sample Zeta Mine/ })).toBeNull();

    await user.click(title);

    expect(title).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: /^Open Sample Zeta Mine/ })).toBeInTheDocument();
  });

  it('opens a minimized Act when a jump link leads into it, then focuses the row there', async () => {
    const user = renderOverview([ZETA, ZETA_2002]);
    const title = screen.getByRole('button', { name: '2002 Act' });
    await user.click(title);

    await user.click(screen.getByRole('link', { name: 'Go to Sample Zeta Mine under the 2002 Act (earlier)' }));

    expect(title).toHaveAttribute('aria-expanded', 'true');
    const act2002 = screen.getByRole('region', { name: '2002 Act' });
    expect(within(act2002).getByRole('link', { name: /^Open Sample Zeta Mine/ })).toHaveFocus();
  });
});

describe('Overview project line', () => {
  it('stays on the overview when the line is pressed outside its links', async () => {
    const user = renderOverview([ZETA]);
    const line = screen.getByRole('link', { name: /^Open Sample Zeta Mine/ }).closest('.wp-ov-row') as HTMLElement;

    await user.click(within(line).getByText('Assessment'));

    expect(screen.getByRole('status', { name: 'Address search' }).textContent).toBe('');
  });
});

describe('Overview expand arrow', () => {
  it('starts minimized to the assessment line, shows the other works on their own lines on press, and minimizes again', async () => {
    const user = renderOverview([ZETA, ZETA_AMENDMENT]);
    const workLink = { name: 'Tailings Amendment, Sample Zeta Mine: open the record' };
    const amendmentMark = { name: /^After certificate: Tailings Amendment\./ };
    const headLine = () => screen.getByRole('link', { name: /^Open Sample Zeta Mine/ }).closest('.wp-ov-row') as HTMLElement;
    expect(screen.getByRole('button', { name: 'Show the works of Sample Zeta Mine' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', workLink)).toBeNull();
    expect(within(headLine()).queryByRole('button', amendmentMark)).toBeNull();
    expect(within(headLine()).getByRole('button', { name: /^Phase: Assessment\. Phase Early Engagement\./ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show the works of Sample Zeta Mine' }));

    expect(screen.getByRole('button', { name: 'Minimize Sample Zeta Mine' })).toHaveAttribute('aria-expanded', 'true');
    const workLine = screen.getByRole('link', workLink).closest('.wp-ov-row') as HTMLElement;
    expect(within(workLine).getByRole('button', amendmentMark)).toBeInTheDocument();
    expect(within(headLine()).queryByRole('button', amendmentMark)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Minimize Sample Zeta Mine' }));

    expect(screen.getByRole('button', { name: 'Show the works of Sample Zeta Mine' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', workLink)).toBeNull();
  });

  it('draws no expand button for a project with only its assessment', () => {
    renderOverview([ZETA]);

    expect(screen.getByRole('link', { name: /^Open Sample Zeta Mine/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sample Zeta Mine$/ })).toBeNull();
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
  it('gives each line one tab stop, which follows the arrow, Home and End keys', async () => {
    const user = renderOverview([ZETA]);
    const line = screen.getByRole('link', { name: /^Open Sample Zeta Mine/ }).closest('.wp-ov-row') as HTMLElement;
    const marks = [...line.querySelectorAll<HTMLElement>('.wp-ov-mk')];
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
