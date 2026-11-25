import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FIXTURE from '../../parity/fixtures/workplans.json';
import type { WorkplanRow } from '../api/sheet-works';
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
    expect(screen.getByText(/^Project 901, 1996 Act\./)).toBeInTheDocument();
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
