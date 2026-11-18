import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FIXTURE from '../../parity/fixtures/workplans.json';
import { json } from '../test-http';
import { withQueryClient } from '../test-query';
import { Workplans } from './Workplans';

const HIDDEN_TRACK_COPY = 'Sample Alpha Transmission Line - Assessment (Track copy)';

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
    expect(screen.queryByRole('link', { name: HIDDEN_TRACK_COPY })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Show replaced and hidden' }));
    expect(screen.getByRole('link', { name: HIDDEN_TRACK_COPY })).toBeInTheDocument();
  });

  it('narrows the works to one Act when its chip is pressed', async () => {
    const user = renderAt('/workplans');

    await screen.findByRole('link', { name: 'Sample Beta Quarry - Amendment' });
    await user.click(screen.getByRole('button', { name: '1996' }));

    expect(screen.getByRole('link', { name: 'Sample Delta Pipeline - Assessment (1996)' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sample Beta Quarry - Amendment' })).toBeNull();
  });

  it.each([
    ['List', () => screen.getByRole('link', { name: 'Sample Beta Quarry - Amendment' })],
    ['Pipeline', () => within(screen.getByRole('region', { name: /^Review / })).getByRole('link', { name: 'Sample Beta Quarry - Amendment' })],
    ['Lookahead', () => screen.getByRole('region', { name: 'Upcoming milestones' })],
  ])('drops the Status chips in %s, and gives the timeline its status back', async (view, shownPart) => {
    const user = renderAt('/workplans');

    await screen.findByRole('region', { name: 'Timeline' });
    await user.click(within(screen.getByRole('group', { name: 'Status' })).getByRole('button', { name: 'Closed' }));
    await user.click(screen.getByRole('button', { name: view }));

    expect(screen.queryByRole('group', { name: 'Status' })).toBeNull();
    expect(shownPart()).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Timeline' }));
    expect(within(screen.getByRole('group', { name: 'Status' })).getByRole('button', { name: 'Closed' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
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
