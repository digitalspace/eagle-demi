import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FIXTURE from '../../parity/fixtures/workplans.json';
import { json } from '../test-http';
import { withQueryClient } from '../test-query';
import { Workplans } from './Workplans';

const HIDDEN_TRACK_WORK = 'Sample Alpha Transmission Line - Substation Assessment';
const OPEN_WORK = 'Sample Beta Quarry - Amendment';
const OTHER_OPEN_WORK = 'Sample Alpha Transmission Line - Assessment';
const CLOSED_1996_WORK = 'Sample Delta Pipeline - Assessment (1996)';

/** `/workplans` answers with `workplans`; the project list and anything else read as empty. */
function renderAt(path: string, workplans: () => Response = () => json(FIXTURE)) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => (String(input).includes('/workplans') ? workplans() : json({}))),
  );
  render(
    withQueryClient(
      <MemoryRouter initialEntries={[path]}>
        <Workplans />
      </MemoryRouter>,
    ),
  );
  return userEvent.setup();
}

afterEach(() => vi.unstubAllGlobals());

describe('Workplans', () => {
  it('says the route is served on dev and test only when it answers 404', async () => {
    renderAt('/workplans', () => json({ error: 'Not found' }, 404));

    expect(await screen.findByText('Workplans are served on dev and test only.')).toBeInTheDocument();
  });

  it('leaves out works the public read hides until Show replaced and hidden is pressed', async () => {
    const user = renderAt('/workplans');

    await screen.findByRole('region', { name: 'Timeline' });
    expect(screen.queryByRole('link', { name: HIDDEN_TRACK_WORK })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Show replaced and hidden' }));
    expect(screen.getByRole('link', { name: HIDDEN_TRACK_WORK })).toBeInTheDocument();
  });

  it('opens the timeline with every work state, and the list with works in progress', async () => {
    const user = renderAt('/workplans');

    await screen.findByRole('link', { name: CLOSED_1996_WORK });
    expect(screen.getByRole('combobox', { name: 'Work state' })).toHaveDisplayValue('All');

    await user.click(screen.getByRole('button', { name: 'List' }));
    expect(screen.getByRole('combobox', { name: 'Work state' })).toHaveDisplayValue('In progress');
    expect(screen.queryByRole('link', { name: CLOSED_1996_WORK })).toBeNull();
  });

  it('shows every state on the list once Work state is cleared', async () => {
    const user = renderAt('/workplans?view=list');

    await screen.findByRole('link', { name: OPEN_WORK });
    await user.click(screen.getByRole('button', { name: 'Clear Work state' }));
    expect(screen.getByRole('link', { name: CLOSED_1996_WORK })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: OPEN_WORK })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Work state' })).toHaveFocus();
  });

  it('keeps a picked Work state when the view changes', async () => {
    const user = renderAt('/workplans');

    await screen.findByRole('link', { name: OPEN_WORK });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Work state' }), 'Closed');
    await user.click(screen.getByRole('button', { name: 'List' }));

    expect(screen.getByRole('combobox', { name: 'Work state' })).toHaveDisplayValue('Closed');
    expect(screen.queryByRole('link', { name: OPEN_WORK })).toBeNull();
  });

  it('the empty-Act note shows every work state', async () => {
    const user = renderAt('/workplans');

    await screen.findByRole('link', { name: CLOSED_1996_WORK });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Work state' }), 'In progress');
    await user.click(screen.getByText('1996 Act', { selector: '.timeline__act-name' }));
    const panel = screen.getByRole('region', { name: '1996 Act timeline' });
    expect(panel).toHaveTextContent('3 works in this Act are hidden by the filters.');

    await user.click(within(panel).getByRole('button', { name: 'Show every work state' }));
    expect(screen.getByRole('link', { name: CLOSED_1996_WORK })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Work state' })).toHaveDisplayValue('All');
  });

  it('ignores Work state Closed on the pipeline, which never shows closed works', async () => {
    const user = renderAt('/workplans');

    await screen.findByRole('link', { name: OPEN_WORK });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Work state' }), 'Closed');
    await user.click(screen.getByRole('button', { name: 'Pipeline' }));

    expect(screen.getByRole('combobox', { name: 'Work state' })).toHaveDisplayValue('All');
    expect(screen.queryByRole('link', { name: CLOSED_1996_WORK })).toBeNull();
    expect(screen.getByRole('link', { name: OPEN_WORK })).toBeInTheDocument();
    // Closed works stay out: with them the pipeline would count 13.
    expect(screen.getByText('6 works')).toBeInTheDocument();
  });

  it('offers only the work types Work state lets through', async () => {
    const user = renderAt('/workplans');
    await screen.findByRole('link', { name: OPEN_WORK });
    const types = () => within(screen.getByRole('combobox', { name: 'Work type' })).queryByRole('option', { name: 'EAC extension' });
    expect(types()).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Work state' }), 'In progress');
    expect(types()).toBeNull();
  });

  it('keeps a picked work type that Work state then rules out, so it can still be cleared', async () => {
    const user = renderAt('/workplans');
    await screen.findByRole('link', { name: OPEN_WORK });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Work type' }), 'EAC extension');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Work state' }), 'In progress');
    expect(screen.queryByRole('link', { name: OPEN_WORK })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Clear Work type' }));
    expect(screen.getByRole('link', { name: OPEN_WORK })).toBeInTheDocument();
  });

  it('narrows the works to one Act when it is picked', async () => {
    const user = renderAt('/workplans');

    await screen.findByRole('link', { name: OPEN_WORK });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Act' }), '1996');

    expect(screen.getByRole('link', { name: CLOSED_1996_WORK })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: OPEN_WORK })).toBeNull();
  });

  it('narrows the list to works whose current phase is the one picked', async () => {
    const user = renderAt('/workplans?view=list');

    await screen.findByRole('link', { name: OTHER_OPEN_WORK });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Phase' }), 'Amendment Review');

    expect(screen.getByRole('link', { name: OPEN_WORK })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: OTHER_OPEN_WORK })).toBeNull();
  });

  it('narrows the works to those whose title, project or type holds the search text', async () => {
    const user = renderAt('/workplans');

    await screen.findByRole('link', { name: OPEN_WORK });
    expect(screen.getByRole('link', { name: OTHER_OPEN_WORK })).toBeInTheDocument();
    await user.type(screen.getByRole('searchbox', { name: 'Search works' }), 'BETA quarry');

    await waitFor(() => expect(screen.queryByRole('link', { name: OTHER_OPEN_WORK })).toBeNull());
    expect(screen.getByRole('link', { name: OPEN_WORK })).toBeInTheDocument();
  });

  it('keeps the search box on the pipeline when nothing matches, and brings the cards back once cleared', async () => {
    const user = renderAt('/workplans?view=pipeline');
    const search = await screen.findByRole('searchbox', { name: 'Search works' });

    await user.type(search, 'no such work');
    expect(await screen.findByText('No works match these filters.')).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search works' })).toBe(search);
    expect(search).toHaveFocus();

    await user.clear(search);
    expect(await screen.findByRole('link', { name: OPEN_WORK })).toBeInTheDocument();
  });

  it('gives the Lookahead its Window and Milestone type in the shared bar, with no Work state', async () => {
    renderAt('/workplans?view=lookahead');

    expect(await screen.findByRole('group', { name: 'Window' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Milestone type' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search works' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Work state' })).toBeNull();
  });

  it.each([
    ['List', () => screen.getByRole('link', { name: OPEN_WORK })],
    ['Pipeline', () => within(screen.getByRole('region', { name: /^Review / })).getByRole('link', { name: OPEN_WORK })],
    ['Lookahead', () => screen.getByRole('region', { name: 'Upcoming milestones' })],
  ])('drops the Status filter in %s, and gives the timeline its status back', async (view, shownPart) => {
    const user = renderAt('/workplans');

    await screen.findByRole('region', { name: 'Timeline' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'Overdue');
    await user.click(screen.getByRole('button', { name: view }));

    expect(screen.queryByRole('combobox', { name: 'Status' })).toBeNull();
    expect(shownPart()).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Timeline' }));
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveDisplayValue('Overdue');
  });

  it('keeps the view in ?view=, opening the list from the link and the timeline from its button', async () => {
    const user = renderAt('/workplans?view=list');

    expect(await screen.findByRole('columnheader', { name: 'Current phase' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'Timeline' }));
    expect(screen.getByRole('region', { name: 'Timeline' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Current phase' })).toBeNull();
  });
});
