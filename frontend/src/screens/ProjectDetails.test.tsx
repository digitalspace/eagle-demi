import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ProjectDetails } from './ProjectDetails';
import { json } from '../test-http';
import { withQueryClient } from '../test-query';

// Brucejack Mine is on the business list of projects with NRPTI data.
const FACTS = { id: '272', name: 'Brucejack Gold Mine', legacyEagleId: '588511caaaecd9001b825bcb' };

function stub() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/projects/272')) return json(FACTS);
      if (url.includes('nrpti') && url.includes(`and%5B_epicProjectIds%5D=${FACTS.legacyEagleId}`)) {
        return json([{ searchResults: [{ _id: 'm1', name: 'Brucejack Mine' }] }]);
      }
      return json([{ searchResults: [] }]);
    }),
  );
}

function renderDetails() {
  return render(
    withQueryClient(
      <MemoryRouter initialEntries={['/project-details/272']}>
        <Routes>
          <Route path="/project-details/:id" element={<ProjectDetails />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('ProjectDetails', () => {
  it('names the project and links back to the details search', async () => {
    stub();

    renderDetails();

    expect(await screen.findByRole('heading', { level: 1, name: 'Brucejack Gold Mine' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /All projects/ })).toHaveAttribute('href', '/project-details');
  });

  it('reads NRPTI by the project’s Eagle id', async () => {
    stub();

    renderDetails();

    expect(await screen.findByText('Brucejack Mine')).toBeInTheDocument();
  });
});
