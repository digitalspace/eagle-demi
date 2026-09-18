import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { PROJECT_LIST_ERROR } from '../api/project-summary';
import { routes } from '../routes';
import { json } from '../test-http';
import { queryWrapper } from '../test-query';
import { stubNarrow } from '../test-setup';
import { NAV_KEY } from './prefs';

function renderShell(at = '/keys') {
  const router = createMemoryRouter(routes, { initialEntries: [at] });
  const Wrapper = queryWrapper();
  render(
    <Wrapper>
      <RouterProvider router={router} />
    </Wrapper>,
  );
  return router;
}

/**
 * The screen under the shell reads from the API too, so every read is answered here: these tests
 * never reach the network, and none of them races a rejection landing mid-assertion. A read whose
 * URL holds `failing` is refused with a 400 — not a 500, which both apps retry twice with a real
 * delay before it settles as an error.
 */
function stubApi(failing?: string) {
  const fetchMock = vi.fn(async (input: unknown) =>
    failing && String(input).includes(failing) ? json({ error: 'unknown parameter' }, 400) : json([]),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const nav = () => screen.getByRole('navigation', { name: 'DEMI' });
const drawerButton = () => screen.queryByRole('button', { name: 'Main navigation' });
const railToggle = () => screen.getByRole('button', { name: 'Toggle navigation' });
const navLinks = () => within(nav()).queryAllByRole('link');

beforeEach(() => {
  window.__env = { ENVIRONMENT: 'test', API_PATH: '/api', KEYCLOAK_REALM: 'eao-epic' };
  stubApi();
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  delete window.__env;
});

describe('the navigation rail', () => {
  it('lists the four groups in order', async () => {
    renderShell();
    await screen.findByRole('banner');

    const headings = within(nav())
      .getAllByText(/^(Discover|Account|Operate|Reference)$/)
      .map((heading) => heading.textContent);

    expect(headings).toEqual(['Discover', 'Account', 'Operate', 'Reference']);
  });

  it('links to every screen, with the picker rather than one project', async () => {
    renderShell();
    await screen.findByRole('banner');

    const hrefs = navLinks().map((link) => link.getAttribute('href'));

    expect(hrefs).toHaveLength(11);
    expect(hrefs).toContain('/projects');
    expect(hrefs.some((href) => href?.startsWith('/projects/'))).toBe(false);
  });

  it('marks the screen being shown as the current page', async () => {
    renderShell('/keys');
    await screen.findByRole('banner');

    expect(screen.getByRole('link', { name: 'API keys' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Search' })).not.toHaveAttribute('aria-current');
  });

  // A 250px rail leaves a 1280px window too little for the search table. Collapsed it narrows to a
  // strip and stays in the row: the toggle inside it is the only control that reopens it.
  it('collapses to a strip from its own toggle, and remembers it', async () => {
    const user = userEvent.setup();
    renderShell();
    await screen.findByRole('banner');

    await user.click(railToggle());

    expect(railToggle()).toHaveAttribute('aria-expanded', 'false');
    expect(nav()).toHaveAttribute('data-open', 'false');
    expect(nav()).not.toHaveAttribute('inert');
    expect(navLinks()).toHaveLength(0);
    expect(localStorage.getItem(NAV_KEY)).toBe('false');
  });

  it('reopens from the toggle left on the collapsed strip', async () => {
    const user = userEvent.setup();
    renderShell();
    await screen.findByRole('banner');

    await user.click(railToggle());
    await user.click(railToggle());

    expect(railToggle()).toHaveAttribute('aria-expanded', 'true');
    expect(navLinks()).toHaveLength(11);
    expect(localStorage.getItem(NAV_KEY)).toBe('true');
  });

  it('starts collapsed when this browser collapsed it before', async () => {
    localStorage.setItem(NAV_KEY, 'false');
    renderShell();
    await screen.findByRole('banner');

    expect(railToggle()).toHaveAttribute('aria-expanded', 'false');
  });

  // Above the breakpoint the rail is already on screen and carries its own toggle, so a header
  // hamburger would be a second control for the same thing.
  it('keeps the header hamburger off the header above the breakpoint', async () => {
    renderShell();
    await screen.findByRole('banner');

    expect(drawerButton()).toBeNull();
  });
});

describe('the navigation drawer below the breakpoint', () => {
  beforeEach(() => stubNarrow(true));

  it('starts closed and out of the page', async () => {
    renderShell();
    await screen.findByRole('banner');

    expect(drawerButton()).toHaveAttribute('aria-expanded', 'false');
    expect(nav()).toHaveAttribute('data-drawer', 'closed');
    expect(nav()).toHaveAttribute('inert');
  });

  it('opens from the header button', async () => {
    const user = userEvent.setup();
    renderShell();
    await screen.findByRole('banner');

    await user.click(drawerButton()!);

    expect(drawerButton()).toHaveAttribute('aria-expanded', 'true');
    expect(nav()).toHaveAttribute('data-drawer', 'open');
    expect(nav()).not.toHaveAttribute('inert');
    expect(drawerButton()).toHaveAttribute('aria-controls', nav().id);
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    renderShell();
    await screen.findByRole('banner');
    await user.click(drawerButton()!);

    await user.keyboard('{Escape}');

    expect(drawerButton()).toHaveAttribute('aria-expanded', 'false');
  });

  // Closing hides the rail outright, so focus left inside it would drop to the document.
  it('closes on following a link inside it and hands focus back to the button', async () => {
    const user = userEvent.setup();
    renderShell();
    await screen.findByRole('banner');
    await user.click(drawerButton()!);

    await user.click(screen.getByRole('link', { name: 'Search' }));

    expect(drawerButton()).toHaveAttribute('aria-expanded', 'false');
    expect(nav()).toHaveAttribute('data-drawer', 'closed');
    expect(drawerButton()).toHaveFocus();
  });

  it('leaves the collapsed desktop rail alone', async () => {
    localStorage.setItem(NAV_KEY, 'false');
    const user = userEvent.setup();
    renderShell();
    await screen.findByRole('banner');

    await user.click(drawerButton()!);

    expect(nav()).toHaveAttribute('data-drawer', 'open');
    expect(localStorage.getItem(NAV_KEY)).toBe('false');
  });
});

describe('the account menu', () => {
  const chip = () => screen.getByRole('button', { name: 'Account menu' });

  it('opens and closes from its own chip', async () => {
    const user = userEvent.setup();
    renderShell();
    await screen.findByRole('banner');

    await user.click(chip());
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.click(chip());
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('walks the items with the arrow keys', async () => {
    const user = userEvent.setup();
    renderShell();
    await screen.findByRole('banner');
    await user.click(chip());

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'My account' })).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Active sessions' })).toHaveFocus();

    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitem', { name: 'My account' })).toHaveFocus();
  });

  it('closes on Escape and hands focus back to the chip', async () => {
    const user = userEvent.setup();
    renderShell();
    await screen.findByRole('banner');
    await user.click(chip());

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(chip()).toHaveFocus();
  });

  it('closes when one of its items navigates', async () => {
    const user = userEvent.setup();
    const router = renderShell();
    await screen.findByRole('banner');
    await user.click(chip());

    await user.click(screen.getByRole('menuitem', { name: 'My account' }));

    expect(router.state.location.pathname).toBe('/workspace');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});

describe('the how-built panel', () => {
  const openPanel = async (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('button', { name: 'How this screen is built' }));

  it('describes the screen the deep link belongs to', async () => {
    const user = userEvent.setup();
    renderShell('/projects/272');
    await screen.findByRole('banner');

    await openPanel(user);

    expect(screen.getByRole('dialog')).toHaveTextContent('How AI Project Summary is built');
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    renderShell();
    await screen.findByRole('banner');
    await openPanel(user);

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('the data-load failure callout', () => {
  const callout = () => screen.queryByRole('alert');

  it('stays hidden while the corpus loads', async () => {
    renderShell();
    await screen.findByRole('banner');

    expect(callout()).not.toBeInTheDocument();
  });

  it('says the list is empty rather than filtered when the load fails', async () => {
    stubApi('dataset=Project');
    renderShell();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('the list below is empty, not filtered');
    expect(alert).toHaveClass('callout', 'callout--warning', 'alert-row');
  });

  // One outage read by one shared query: the picker already says so in its own card.
  it('stays off a screen that reports the same failure itself', async () => {
    stubApi('dataset=Project');
    renderShell('/projects');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(PROJECT_LIST_ERROR);
    expect(document.querySelectorAll('.alert-row')).toHaveLength(0);
  });

  it('shows on a registry screen, which carries no callout of its own', async () => {
    stubApi('dataset=Project');
    renderShell('/map');

    expect(await screen.findByRole('alert')).toHaveClass('alert-row');
  });

  it('re-reads the corpus on Retry, and drops the callout once it answers', async () => {
    const user = userEvent.setup();
    let refuse = true;
    const fetchMock = vi.fn(async (input: unknown) =>
      refuse && String(input).includes('dataset=Project')
        ? json({ error: 'unknown parameter' }, 400)
        : json([]),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderShell();
    await screen.findByRole('alert');

    refuse = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(callout()).not.toBeInTheDocument());
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });
});
