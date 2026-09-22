import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiKeys } from './ApiKeys';
import { json, requests } from '../test-http';
import { renderScreen } from '../test-query';
import type { ApiKey } from '../api/api-keys';

const day = 86_400_000;

const key = (over: Partial<ApiKey> = {}): ApiKey => ({
  id: 'ak_c02da6f1',
  name: 'epic-map-frontend',
  roles: ['demi-service-read'],
  projectScope: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  createdBy: 'j.okafor',
  expiresAt: new Date(Date.now() + 90 * day).toISOString(),
  revokedAt: null,
  lastUsedAt: null,
  ...over,
});

/** Answer the list read with `rows`, and any write with `onWrite`. */
function stub(rows: ApiKey[], onWrite: (init?: RequestInit) => Response = () => json({})) {
  const fetchMock = vi.fn((_input: unknown, init?: RequestInit) =>
    Promise.resolve(init?.method ? onWrite(init) : json(rows)),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The number on the stat card under `label`. The cards carry no role of their own. */
const statFor = (label: string) =>
  screen.getAllByText(label).find((node) => node.className === 'micro-label')?.parentElement
    ?.querySelector('.stat-card__value')?.textContent;

beforeEach(() => vi.stubGlobal('confirm', vi.fn(() => true)));

afterEach(() => vi.unstubAllGlobals());

describe('ApiKeys', () => {
  it('lists the keys with their derived status and counts them', async () => {
    stub([key(), key({ id: 'b', expiresAt: new Date(Date.now() + 5 * day).toISOString() }), key({ id: 'c', revokedAt: '2026-08-20T00:00:00.000Z' })]);

    renderScreen(<ApiKeys />);

    expect(await screen.findAllByText('epic-map-frontend')).toHaveLength(3);
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows.map((row) => within(row).getByText(/^(Active|Expiring|Expired|Revoked)$/).textContent)).toEqual([
      'Active',
      'Expiring',
      'Revoked',
    ]);
    // An expiring key is counted as active too: it is still authenticating.
    expect(statFor('Keys')).toBe('3');
    expect(statFor('Active keys')).toBe('2');
    expect(statFor('Expiring in 30 days')).toBe('1');
    expect(statFor('Revoked')).toBe('1');
  });

  it('says the registry is empty rather than showing a blank table', async () => {
    stub([]);

    renderScreen(<ApiKeys />);

    expect(await screen.findByText('No keys have been minted.')).toBeInTheDocument();
  });

  it('shows the API error message when the list read fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'Admin routes are closed' }, 500)));

    renderScreen(<ApiKeys />);

    expect(await screen.findByText('Admin routes are closed')).toBeInTheDocument();
  });

  it('names All projects when a key carries no scope, and the ids when it does', async () => {
    stub([key(), key({ id: 'b', projectScope: ['402', '111'] })]);

    renderScreen(<ApiKeys />);

    expect(await screen.findByText('All projects')).toBeInTheDocument();
    expect(screen.getByText('402, 111')).toBeInTheDocument();
  });

  it('refuses to mint until a name and a role are given', async () => {
    const user = userEvent.setup();
    stub([]);

    renderScreen(<ApiKeys />);
    await user.click(await screen.findByRole('button', { name: 'Mint a key' }));

    const mint = screen.getByRole('button', { name: 'Mint key' });
    expect(mint).toBeDisabled();

    await user.type(screen.getByRole('textbox', { name: 'Consumer name' }), 'epic-map-frontend');
    expect(mint).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: 'demi-service-read' }));
    expect(mint).toBeEnabled();
  });

  it('demands the write confirmation before a write role can be minted', async () => {
    const user = userEvent.setup();
    stub([]);

    renderScreen(<ApiKeys />);
    await user.click(await screen.findByRole('button', { name: 'Mint a key' }));
    await user.type(screen.getByRole('textbox', { name: 'Consumer name' }), 'writer');
    await user.click(screen.getByRole('checkbox', { name: 'demi-service-write' }));

    const confirmWrite = screen.getByRole('checkbox', { name: /may mutate data/ });
    expect(screen.getByRole('button', { name: 'Mint key' })).toBeDisabled();

    await user.click(confirmWrite);
    expect(screen.getByRole('button', { name: 'Mint key' })).toBeEnabled();
  });

  it('sends the scope as a list and reveals the secret once', async () => {
    const user = userEvent.setup();
    const fetchMock = stub([], () => json({ ...key(), key: 'demi_test_c02da6f1_secret' }, 201));

    renderScreen(<ApiKeys />);
    await user.click(await screen.findByRole('button', { name: 'Mint a key' }));
    await user.type(screen.getByRole('textbox', { name: 'Consumer name' }), 'epic-map-frontend');
    await user.click(screen.getByRole('checkbox', { name: 'demi-service-read' }));
    await user.type(screen.getByRole('textbox', { name: /Project scope, optional/ }), '402, 111');
    await user.click(screen.getByRole('button', { name: 'Mint key' }));

    expect(await screen.findByText('demi_test_c02da6f1_secret')).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST')!;
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({
      name: 'epic-map-frontend',
      roles: ['demi-service-read'],
      projectScope: ['402', '111'],
    });
    // The form closes on success, so the secret cannot be minted twice by a second click.
    expect(screen.queryByRole('button', { name: 'Mint key' })).not.toBeInTheDocument();
  });

  it('copies the secret to the clipboard and drops it on dismiss', async () => {
    const user = userEvent.setup();
    stub([], () => json({ ...key(), key: 'demi_test_c02da6f1_secret' }, 201));

    renderScreen(<ApiKeys />);
    await user.click(await screen.findByRole('button', { name: 'Mint a key' }));
    await user.type(screen.getByRole('textbox', { name: 'Consumer name' }), 'x');
    await user.click(screen.getByRole('checkbox', { name: 'demi-service-read' }));
    await user.click(screen.getByRole('button', { name: 'Mint key' }));
    await user.click(await screen.findByRole('button', { name: 'Copy secret' }));

    // userEvent installs its own clipboard, so this reads back what the screen actually wrote.
    await expect(navigator.clipboard.readText()).resolves.toBe('demi_test_c02da6f1_secret');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('demi_test_c02da6f1_secret')).not.toBeInTheDocument();
  });

  it('reports a refused mint and reveals no secret', async () => {
    const user = userEvent.setup();
    stub([], () => json({ error: 'Unknown role(s): wizard' }, 400));

    renderScreen(<ApiKeys />);
    await user.click(await screen.findByRole('button', { name: 'Mint a key' }));
    await user.type(screen.getByRole('textbox', { name: 'Consumer name' }), 'x');
    await user.click(screen.getByRole('checkbox', { name: 'demi-service-read' }));
    await user.click(screen.getByRole('button', { name: 'Mint key' }));

    expect(await screen.findByText('Unknown role(s): wizard')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy secret' })).not.toBeInTheDocument();
    // The form stays open over its own rejection, so the roles are not retyped.
    expect(screen.getByRole('button', { name: 'Mint key' })).toBeInTheDocument();
  });

  it('sends nothing when the revoke confirmation is declined', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('confirm', vi.fn(() => false));
    const fetchMock = stub([key()]);

    renderScreen(<ApiKeys />);
    await user.click(await screen.findByRole('button', { name: 'Revoke' }));

    expect(requests(fetchMock).filter((call) => call.startsWith('DELETE'))).toEqual([]);
  });

  it('revokes the key once the confirmation is accepted', async () => {
    const user = userEvent.setup();
    const fetchMock = stub([key()], () => new Response(null, { status: 204 }));

    renderScreen(<ApiKeys />);
    await user.click(await screen.findByRole('button', { name: 'Revoke' }));

    await waitFor(() =>
      expect(requests(fetchMock)).toContain('DELETE http://localhost:3000/api/admin/api-keys/ak_c02da6f1'),
    );
  });

  it('rotates by minting the replacement before revoking the old key', async () => {
    const user = userEvent.setup();
    const fetchMock = stub([key({ roles: ['demi-service-write'], projectScope: ['402'] })], (init) =>
      init?.method === 'POST' ? json({ ...key(), key: 'demi_test_new_secret' }, 201) : new Response(null, { status: 204 }),
    );

    renderScreen(<ApiKeys />);
    await user.click(await screen.findByRole('button', { name: 'Rotate' }));

    await waitFor(() =>
      expect(requests(fetchMock)).toContain('DELETE http://localhost:3000/api/admin/api-keys/ak_c02da6f1'),
    );
    const calls = requests(fetchMock);
    const posted = calls.findIndex((call) => call.startsWith('POST'));
    const deleted = calls.findIndex((call) => call.startsWith('DELETE'));
    expect(posted).toBeGreaterThanOrEqual(0);
    expect(deleted).toBeGreaterThan(posted);

    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST')!;
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({
      name: 'epic-map-frontend',
      roles: ['demi-service-write'],
      projectScope: ['402'],
      allowWrite: true,
    });
  });

  it('offers no row actions on a revoked key', async () => {
    stub([key({ revokedAt: '2026-08-20T00:00:00.000Z' })]);

    renderScreen(<ApiKeys />);

    await screen.findByText('epic-map-frontend');
    const row = screen.getByText('epic-map-frontend').closest('tr')!;
    expect(within(row).queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Rotate' })).not.toBeInTheDocument();
  });
});
