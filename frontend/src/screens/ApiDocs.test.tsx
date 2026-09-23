import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiDocs } from './ApiDocs';
import { renderScreen } from '../test-query';

/** The screen reads config at render time, so the module-level store is set the way env.js sets it. */
async function withConfig(values: Record<string, unknown>) {
  window.__env = values;
  const { initConfig } = await import('../config');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
  await initConfig();
}

afterEach(() => {
  delete window.__env;
  vi.unstubAllGlobals();
});

describe('ApiDocs', () => {
  it('offers Swagger UI on an environment that serves it', async () => {
    await withConfig({ ENVIRONMENT: 'TEST' });

    renderScreen(<ApiDocs />);

    expect(screen.getByRole('button', { name: 'Open Swagger UI' })).toBeInTheDocument();
  });

  it('hides the link and says why on an environment that does not', async () => {
    await withConfig({ ENVIRONMENT: 'prod' });

    renderScreen(<ApiDocs />);

    expect(screen.queryByRole('button', { name: 'Open Swagger UI' })).not.toBeInTheDocument();
    expect(screen.getByText(/serves it on dev and test only/)).toBeInTheDocument();
  });

  it('opens the spec under the API path, in a window that cannot reach back', async () => {
    const user = userEvent.setup();
    await withConfig({ ENVIRONMENT: 'dev', API_PATH: '/api' });
    const open = vi.fn();
    vi.stubGlobal('open', open);

    renderScreen(<ApiDocs />);
    await user.click(screen.getByRole('button', { name: 'Open Swagger UI' }));

    expect(open).toHaveBeenCalledWith('/api/api-docs', '_blank', 'noopener');
  });

  it('refuses an API path that would navigate off this origin', async () => {
    const user = userEvent.setup();
    await withConfig({ ENVIRONMENT: 'dev', API_PATH: 'https://example.invalid/api' });
    const open = vi.fn();
    vi.stubGlobal('open', open);

    renderScreen(<ApiDocs />);
    await user.click(screen.getByRole('button', { name: 'Open Swagger UI' }));

    expect(open).toHaveBeenCalledWith('/api/api-docs', '_blank', 'noopener');
  });

  it('lists each role against what it may read, write and administer', async () => {
    await withConfig({ ENVIRONMENT: 'test' });

    renderScreen(<ApiDocs />);

    const row = screen.getByText('demi-service-write').closest('tr')!;
    expect(row.textContent).toContain('everything the ACL allows');
    expect(screen.getByText('project:<id>')).toBeInTheDocument();
  });
});
