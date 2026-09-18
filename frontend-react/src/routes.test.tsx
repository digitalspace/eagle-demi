import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { PREFS_KEY } from './shell/prefs';
import { apiDocsTarget, routes } from './routes';

/**
 * The index search and document content screens were folded into one page, so their links and
 * bookmarks have to land on the same results the reader asked for.
 */
async function go(url: string): Promise<string> {
  const router = createMemoryRouter(routes, { initialEntries: [url] });
  render(<RouterProvider router={router} />);
  await screen.findByRole('banner');
  return router.state.location.pathname + router.state.location.search;
}

beforeEach(() => {
  window.__env = { ENVIRONMENT: 'test', API_PATH: '/api' };
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  delete window.__env;
});

describe('legacy search links', () => {
  it('sends an old index search link to the search page', async () => {
    expect(await go('/index')).toBe('/search');
  });

  it('sends an old content search link to the search page, inside documents', async () => {
    expect(await go('/content')).toBe('/search?record=documents&scope=inside');
  });

  it('carries the words from an old link over as the keyword', async () => {
    expect(await go('/index?q=Cariboo%20Gold')).toBe('/search?keywords=Cariboo%20Gold');
  });

  it('keeps the inside-documents scope alongside the carried words', async () => {
    expect(await go('/content?q=caribou')).toBe('/search?record=documents&scope=inside&keywords=caribou');
  });

  // The old screens held sort and tab state the grid reads from different keys; a guessed
  // translation would open on a view nobody asked for.
  it('drops an old parameter the search page has no place for', async () => {
    expect(await go('/index?q=mine&sortBy=name&scopeTab=documents')).toBe('/search?keywords=mine');
  });
});

describe('redirects', () => {
  it('sends an old /profile link to My account', async () => {
    expect(await go('/profile')).toBe('/workspace');
  });

  it('sends an unknown path to the map', async () => {
    expect(await go('/nothing-here')).toBe('/map');
  });

  it('opens on the map when no landing screen is saved', async () => {
    expect(await go('/')).toBe('/map');
  });

  it('opens on the saved landing screen', async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ landing: 'search', perPage: 6 }));

    expect(await go('/')).toBe('/search');
  });

  // The spec is a route under the API base; the SPA catch-all would otherwise swallow it.
  it('leaves the app for the API when the swagger route is asked for', async () => {
    const replace = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      replace,
    } as unknown as Location);

    const router = createMemoryRouter(routes, { initialEntries: ['/api-docs'] });
    render(<RouterProvider router={router} />);
    await screen.findByRole('banner');

    expect(replace).toHaveBeenCalledWith('/api/api-docs');
  });
});

// API_PATH is remote-settable: /api/config merges last, so a compromised or misconfigured config
// document could otherwise point this navigation at any origin it liked.
describe('the swagger bounce target', () => {
  it('follows a same-origin API path', () => {
    expect(apiDocsTarget('/api')).toBe('/api/api-docs');
    expect(apiDocsTarget('/demi/api')).toBe('/demi/api/api-docs');
  });

  it('refuses an absolute URL to another origin', () => {
    expect(apiDocsTarget('https://evil.example')).toBe('/api/api-docs');
  });

  it('refuses a scheme-relative host', () => {
    expect(apiDocsTarget('//evil.example')).toBe('/api/api-docs');
  });

  it('refuses a javascript: value', () => {
    expect(apiDocsTarget('javascript:alert(document.cookie)')).toBe('/api/api-docs');
  });

  it('falls back when the key is missing or not a string', () => {
    expect(apiDocsTarget(undefined)).toBe('/api/api-docs');
    expect(apiDocsTarget('')).toBe('/api/api-docs');
    expect(apiDocsTarget({ toString: () => '/api' })).toBe('/api/api-docs');
  });

  it('sends the browser to the fallback when the configured path is hostile', async () => {
    window.__env = { ENVIRONMENT: 'test', API_PATH: 'https://evil.example' };
    const replace = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      replace,
    } as unknown as Location);

    const router = createMemoryRouter(routes, { initialEntries: ['/api-docs'] });
    render(<RouterProvider router={router} />);
    await screen.findByRole('banner');

    expect(replace).toHaveBeenCalledWith('/api/api-docs');
  });
});

describe('the screens', () => {
  it('renders each screen inside the shell, under its own title', async () => {
    await go('/keys');

    expect(await screen.findByRole('heading', { level: 1, name: 'API keys' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'DEMI' })).toBeInTheDocument();
  });

  it('keeps a deep project link on the project screen', async () => {
    expect(await go('/projects/272')).toBe('/projects/272');
    expect(await screen.findByRole('heading', { level: 1, name: 'AI Project Summary' })).toBeInTheDocument();
  });
});
