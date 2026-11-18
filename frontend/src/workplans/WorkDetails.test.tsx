import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WORKPLANS from '../../parity/fixtures/workplans.json';
import SHEET from '../../parity/fixtures/projects-901-sheet-works.json';
import PROJECTS from '../../parity/fixtures/search-project.json';
import type { WorkplanRow } from '../api/sheet-works';
import type { Project } from '../api/types';
import { json } from '../test-http';
import { renderScreen } from '../test-query';
import { rowsOf } from './derive';
import { WorkDetails } from './WorkDetails';

const ALPHA_2002 = 'Sample Alpha Transmission Line - Assessment (2002)';
const DELTA_1996 = 'Sample Delta Pipeline - Assessment (1996)';
const ALPHA: Project = { id: 901, name: 'Sample', gatingState: 'admitted', region: 'Sample Region North', type: 'Mines' };

/** `/sheet-works` answers with `sheet`, the project list with the search fixture. */
function renderDetails(title: string, sheet: () => Response = () => json(SHEET)) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/sheet-works')) return sheet();
      return url.includes('/search') ? json(PROJECTS) : json({});
    }),
  );
  const row = rowsOf(WORKPLANS.works as WorkplanRow[], [ALPHA], '2026-11-17').find((r) => r.work.title === title)!;
  renderScreen(<WorkDetails row={row} id="details-1" />);
}

afterEach(() => vi.unstubAllGlobals());

describe('WorkDetails', () => {
  it('shows the stored work’s milestones under where it came from and who proposed it', async () => {
    renderDetails(ALPHA_2002);

    const panel = screen.getByRole('region', { name: `${ALPHA_2002}, 2002 Act` });
    expect(panel).toHaveAttribute('id', 'details-1');
    expect(panel).toHaveAttribute('aria-busy', 'true');
    const milestones = await within(panel).findByRole('list', { name: 'Milestones' });
    expect(within(milestones).getByText('Public comment period')).toBeInTheDocument();
    expect(
      await within(panel).findByText(
        'Environmental Assessment Certificate (EAC) · Moved from the 1996 Act · Region: Sample Region North · Proponent: Sample Energy Co',
      ),
    ).toBeInTheDocument();
    expect(panel).toHaveAttribute('aria-busy', 'false');
    expect(within(panel).getByRole('status')).toHaveTextContent('Details loaded');
    expect(within(panel).queryByText(SHEET.works[1].title)).toBeNull();
  });

  it('spells out the certificate a 1996 work issues', async () => {
    renderDetails(DELTA_1996);

    expect(await screen.findByText(/^Project Approval Certificate \(PAC\)/)).toBeInTheDocument();
  });

  it.each([
    ['the project has no such stored work', () => json({ works: [] })],
    ['the read fails', () => json({ error: 'no' }, 500)],
  ])('points to the project page when %s', async (_case, sheet) => {
    renderDetails(ALPHA_2002, sheet);

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Details are not available.'));
    expect(screen.getByRole('link', { name: 'Open the project page' })).toHaveAttribute('href', '/project-details/901');
  });
});
