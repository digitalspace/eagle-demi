import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FIXTURE from '../../parity/fixtures/workplans.json';
import type { WorkplanMilestone, WorkplanRow } from '../api/sheet-works';
import { json } from '../test-http';
import { withQueryClient } from '../test-query';
import { stubResizeObserver } from '../workplans/__tests__/dom';
import { phaseOf, workOf } from '../workplans/__tests__/works';
import { WorkplanRecord } from './WorkplanRecord';

function renderAt(path: string, works: readonly WorkplanRow[] = FIXTURE.works as unknown as WorkplanRow[]) {
  vi.stubGlobal('fetch', vi.fn(async () => json({ works })));
  stubResizeObserver();
  render(
    withQueryClient(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/workplans/:projectId" element={<WorkplanRecord />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('WorkplanRecord', () => {
  it('opens the project named in the path under the Act in ?act=', async () => {
    renderAt('/workplans/901?act=1996');

    expect(await screen.findByRole('heading', { level: 1, name: 'Sample Alpha Transmission Line' })).toBeInTheDocument();
    const facts = screen.getAllByRole('definition').map((d) => d.textContent);
    expect(facts.slice(0, 2)).toEqual(['901', '1996 Act']);
  });

  it('says there are no works for an id the body does not hold', async () => {
    renderAt('/workplans/999?act=2018');

    expect(await screen.findByRole('heading', { level: 1, name: 'No works for project 999' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to all works' })).toHaveAttribute('href', '/workplans');
  });

  it('marks an outcome taken from the Track copy', async () => {
    renderAt('/workplans/905?act=2002');

    await screen.findByRole('heading', { level: 1, name: 'Sample Epsilon Terminal' });
    expect(screen.getAllByText('Approved (from Track)').length).toBeGreaterThan(0);
  });

  it('puts Extra Time between Evaluation and Application Review on a 2002 record', async () => {
    const sheet = workOf(
      [
        phaseOf('Application Review', '2006-01-01', '2006-06-01', { order: 4, isCompleted: true }),
        phaseOf('Extra Time', '2005-09-01', '2005-12-31', { order: 3, isCompleted: true }),
        phaseOf('Evaluation', '2005-06-01', '2005-08-31', { order: 2, isCompleted: true }),
        phaseOf('Pre-Application', '2005-01-01', '2005-05-31', { order: 1, isCompleted: true }),
      ],
      { source: 'sheet', actYear: 2002, workState: 'completed', isActive: false, title: 'Sample Zeta Mine - Assessment (2002)' },
    );
    renderAt('/workplans/950?act=2002', [sheet]);

    await screen.findByRole('heading', { level: 1, name: 'Sample Zeta Mine' });
    const rows = screen.getByRole('region', { name: /^Timeline rows/ }).textContent ?? '';
    const at = ['Pre-Application', 'Evaluation', 'Extra Time', 'Application Review'].map((name) => rows.indexOf(name));
    expect(at[0]).toBeGreaterThanOrEqual(0);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });
});

const milestone = (kind: WorkplanMilestone['kind'], name: string, at: Partial<WorkplanMilestone>): WorkplanMilestone => ({
  name,
  actualDate: null,
  anticipatedDate: null,
  endDate: null,
  outcome: null,
  numberOfDays: null,
  code: null,
  eventType: null,
  position: null,
  kind,
  ...at,
});

/** A finished Track assessment with one 180-day legislated phase extended by 30 days. */
const reviewWork = (extension: Partial<WorkplanMilestone>) =>
  workOf([phaseOf('Application Review', '2020-01-01', '2020-06-30', { isCompleted: true, numberOfDays: 180, legislated: true, extensionDays: 30 })], {
    workState: 'COMPLETED',
    isActive: false,
    milestones: [milestone('extension', 's.24(4) Extension of Time Limit', { numberOfDays: 30, ...extension })],
  });

/** The value beside the first term named `k`: the header's facts come before the other blocks' summaries. */
const factOf = (k: string) => screen.getAllByRole('term').find((t) => t.textContent === k)?.nextElementSibling?.textContent;

describe('WorkplanRecord header', () => {
  afterEach(() => vi.useRealTimers());

  it('labels the work state, the team and the allotted days, projecting a running phase at its planned length', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-03-01T12:00:00Z') });
    const work = workOf(
      [
        phaseOf('Early Engagement', '2026-01-01', '2026-02-14', { order: 1, isCompleted: true, numberOfDays: 30, legislated: true }),
        phaseOf('Process Planning', '2026-02-15', null, { order: 2, isCurrent: true, numberOfDays: 60, legislated: true }),
      ],
      { team: 'Team A' },
    );
    renderAt('/workplans/950?act=2018', [work]);

    await screen.findByRole('heading', { level: 1, name: 'Sample Zeta Mine' });
    expect(factOf('Work state')).toBe('In progress, active');
    expect(factOf('Team')).toBe('Team A');
    expect(factOf('Total allotted days')).toBe('90 days');
    // 44 days taken in Early Engagement plus Process Planning's 60 planned, as it is still under them.
    expect(factOf('Projected')).toBe('104 days, 14 over');
  });

  it('tags an assessment moved to a later Act as Moved beside the name', async () => {
    const moved = workOf([phaseOf('Application Review', '2018-01-01', '2019-12-16', { isCompleted: true })], {
      source: 'sheet',
      actYear: 2002,
      workState: 'completed',
      isActive: false,
      title: 'Sample Zeta Mine - Assessment (2002)',
      transitionOut: { toActYear: 2018, date: '2019-12-16' },
    });
    renderAt('/workplans/950?act=2002', [moved]);

    const title = await screen.findByRole('heading', { level: 1, name: 'Sample Zeta Mine' });
    // The tag sits in the facts line right under the name; the Act stepper says Moved too.
    expect(within(title.nextElementSibling as HTMLElement).getByText('Moved')).toBeInTheDocument();
    expect(factOf('Moved to the 2018 Act')).toBe('2019-12-16, no decision under this Act');
  });

  it('lists who is on each work by role', async () => {
    const work = workOf([phaseOf('Early Engagement', '2020-01-01', null, { isCurrent: true })], {
      staff: [
        { name: 'Staff One', role: 'Work lead' },
        { name: 'Staff Two', role: 'Responsible EPD' },
        { name: 'Staff Three', role: 'Officer' },
      ],
    });
    renderAt('/workplans/950?act=2018', [work]);

    const table = await screen.findByRole('table', { name: 'People on each work under this Act' });
    expect(within(table).getByRole('rowheader').textContent).toBe('Assessment');
    expect(within(table).getAllByRole('cell').map((c) => c.textContent)).toEqual(['In progress, active', 'Staff One', 'Staff Two', 'Staff Three (Officer)']);
  });

  it('lets the keyboard reach the people table to scroll it sideways', async () => {
    renderAt('/workplans/950?act=2018', [workOf([phaseOf('Early Engagement', '2020-01-01', null, { isCurrent: true })], { staff: [{ name: 'Staff One', role: 'Work lead' }] })]);

    const scroller = await screen.findByRole('region', { name: 'People on each work under this Act' });
    scroller.focus();
    expect(scroller).toHaveFocus();
    expect(scroller).toContainElement(screen.getByRole('table', { name: 'People on each work under this Act' }));
  });

  it('shows no people table when Track sends no staff', async () => {
    renderAt('/workplans/901?act=1996');

    await screen.findByRole('heading', { level: 1, name: 'Sample Alpha Transmission Line' });
    expect(screen.queryByRole('table', { name: 'People on each work under this Act' })).toBeNull();
  });
});

describe('WorkplanRecord phases', () => {
  const ee = phaseOf('Early Engagement', '2021-07-31', '2021-10-28', { order: 1, isCompleted: true });
  const pp = phaseOf('Process Planning', '2021-10-29', '2022-08-11', { order: 3, isCompleted: true });
  const rd = phaseOf('Readiness Decision', '2022-08-12', '2022-09-30', { order: 2, isCompleted: true });

  it('draws Track phases in the order they started, not the order Track numbers them', async () => {
    renderAt('/workplans/950?act=2018', [workOf([ee, rd, pp])]);

    await screen.findByRole('heading', { level: 1, name: 'Sample Zeta Mine' });
    const rows = screen.getByRole('region', { name: /^Timeline rows/ }).textContent ?? '';
    const at = ['Early Engagement', 'Process Planning', 'Readiness Decision'].map((name) => rows.indexOf(name));
    expect(at[0]).toBeGreaterThanOrEqual(0);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('counts a non-legislated phase from Day One, so its start day is day 1', async () => {
    renderAt('/workplans/950?act=2018', [workOf([phaseOf('Early Engagement', '2020-01-01', '2020-01-31', { isCompleted: true })])]);

    await screen.findByRole('heading', { level: 1, name: 'Sample Zeta Mine' });
    expect(screen.getByRole('region', { name: /^Timeline rows/ })).toHaveTextContent(/2020-01-01 to 2020-01-31, 31\sdays/);
  });

  it('notes a gap between phases and an overlap past their shared day', async () => {
    const gapped = [
      phaseOf('Early Engagement', '2020-01-01', '2020-01-31', { order: 1, isCompleted: true }),
      phaseOf('Process Planning', '2020-02-11', '2020-03-31', { order: 2, isCompleted: true }),
      phaseOf('Readiness Decision', '2020-03-27', '2020-05-01', { order: 3, isCompleted: true }),
    ];
    renderAt('/workplans/950?act=2018', [workOf(gapped)]);

    const notes = within(await screen.findByRole('region', { name: 'Notes on this record' }));
    expect(notes.getByText('Dates conflict: 10 days between Early Engagement and Process Planning; phases should follow with no gap')).toBeInTheDocument();
    expect(notes.getByText('Dates conflict: Readiness Decision starts 4 days before Process Planning ends')).toBeInTheDocument();
  });

  it('takes a phase starting on the day the one before ends as following on, with no dates conflict', async () => {
    const shared = [
      phaseOf('Early Engagement', '2020-01-01', '2020-01-31', { order: 1, isCompleted: true }),
      phaseOf('Process Planning', '2020-01-31', '2020-03-31', { order: 2, isCompleted: true }),
    ];
    renderAt('/workplans/950?act=2018', [workOf(shared)]);

    await screen.findByRole('heading', { level: 1, name: 'Sample Zeta Mine' });
    expect(screen.queryByText(/^Dates conflict: Process Planning starts/)).toBeNull();
  });
});

describe('WorkplanRecord time limit changes', () => {
  const block = async () => within(await screen.findByRole('region', { name: 'Time limit changes' }));

  it('gives a phase changed only by extensions one Date column and a Days extended column', async () => {
    renderAt('/workplans/950?act=2018', [reviewWork({ actualDate: '2020-03-01' })]);

    const headers = (await block()).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Change', 'Section', 'Date', 'Days extended']);
  });

  it("lets the keyboard reach a phase's changes table to scroll it sideways", async () => {
    renderAt('/workplans/950?act=2018', [reviewWork({ actualDate: '2020-03-01' })]);

    const scroller = (await block()).getByRole('region', { name: 'Application Review' });
    scroller.focus();
    expect(scroller).toHaveFocus();
    expect(scroller).toContainElement(within(scroller).getByRole('table'));
  });

  it('sums up the time allowed, the days left and the deadline of a legislated phase', async () => {
    renderAt('/workplans/950?act=2018', [reviewWork({ actualDate: '2020-03-01' })]);

    await block();
    expect(factOf('Time allowed')).toBe('210 days');
    // 181 days taken, counted from Day Zero: the phase is first in its work.
    expect(factOf('Days left')).toBe('29 days');
    expect(factOf('Deadline')).toBe('2020-07-29');
  });

  it('counts no days for a planned extension that has not been granted', async () => {
    renderAt('/workplans/950?act=2018', [reviewWork({ anticipatedDate: '2020-03-01' })]);

    expect((await block()).getByText('planned, not yet granted: not counted')).toBeInTheDocument();
  });
});

describe('WorkplanRecord events', () => {
  const phases = [phaseOf('Application Review', '2020-01-01', '2020-09-30', { isCompleted: true })];

  it('offers a Submissions chip that lists the submission events', async () => {
    const work = workOf(phases, { milestones: [milestone('submission', 'Application submitted', { actualDate: '2020-02-01' })] });
    const user = userEvent.setup();
    renderAt('/workplans/950?act=2018', [work]);

    await user.click(await screen.findByRole('button', { name: /^Submissions/ }));

    const list = screen.getByRole('list', { name: 'Events' });
    expect(within(list).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([expect.stringMatching(/^Submission, 2020-02-01, Application submitted/)]);
  });

  it('says the new event count in a live region when a chip is pressed', async () => {
    const work = workOf(phases, { milestones: [milestone('submission', 'Application submitted', { actualDate: '2020-02-01' })] });
    const user = userEvent.setup();
    renderAt('/workplans/950?act=2018', [work]);

    await user.click(await screen.findByRole('button', { name: /^Submissions/ }));

    expect(screen.getByText(/Showing 1 of \d+ events/).closest('[aria-live="polite"]')).not.toBeNull();
  });

  it('marks a second decision on the decision day, with no outcome of its own, by the work outcome', async () => {
    // The first decision on that day is drawn on the axis; the second sits on its phase row.
    const work = workOf(phases, {
      workState: 'COMPLETED',
      isActive: false,
      decisionDate: '2020-09-30',
      outcome: 'Terminated',
      milestones: [milestone('decision', 'Minister decision', { actualDate: '2020-09-30' }), milestone('decision', 'Order issued', { actualDate: '2020-09-30' })],
    });
    renderAt('/workplans/950?act=2018', [work]);

    const legend = await screen.findByRole('list', { name: 'Marks on this record' });
    expect(within(legend).getByText('Decision, refused or terminated')).toBeInTheDocument();
  });

  it('lists the later works beside the assessment events', async () => {
    const amendment = workOf([phaseOf('Amendment Review', '2021-01-01', '2021-03-31', { isCompleted: true })], {
      workId: 'track-950-amd',
      workTypeCode: 'amendment',
      workType: 'Amendment',
      title: 'Sample Zeta Mine - Tailings Amendment',
      workState: 'COMPLETED',
      isActive: false,
    });
    renderAt('/workplans/950?act=2018', [workOf(phases, { workState: 'COMPLETED', isActive: false }), amendment]);

    const events = within(await screen.findByRole('region', { name: /^Events/ }));
    expect(events.getByRole('heading', { level: 3, name: 'Later works' })).toBeInTheDocument();
    expect(events.getByRole('list', { name: 'Later works' })).toBeInTheDocument();
  });
});
