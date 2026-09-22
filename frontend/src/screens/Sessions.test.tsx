import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Sessions } from './Sessions';
import { renderScreen } from '../test-query';

const claims = vi.hoisted(() => ({
  value: { sessionId: '', preferredUsername: '', issuedAt: undefined as number | undefined, expiresAt: undefined as number | undefined },
}));

const logout = vi.hoisted(() => vi.fn());

vi.mock('../api/keycloak', () => ({
  getSessionClaims: () => claims.value,
  logout,
  getToken: () => undefined,
  refreshToken: async () => false,
}));

const ISSUED = Date.parse('2026-09-18T10:00:00.000Z') / 1000;
const EXPIRES = Date.parse('2026-09-18T10:05:00.000Z') / 1000;

const dataRow = () => screen.getAllByRole('row')[1];

afterEach(() => vi.clearAllMocks());

describe('Sessions', () => {
  it('reads the session id and both token times off the access token', () => {
    claims.value = { sessionId: 'abc-123', preferredUsername: 'j.okafor', issuedAt: ISSUED, expiresAt: EXPIRES };

    renderScreen(<Sessions />, { authenticated: true, isStaff: true });

    const row = within(dataRow());
    expect(row.getByText('abc-123')).toBeInTheDocument();
    expect(row.getByText(new Date(ISSUED * 1000).toLocaleString('en-CA'))).toBeInTheDocument();
    expect(row.getByText(new Date(EXPIRES * 1000).toLocaleString('en-CA'))).toBeInTheDocument();
    expect(row.getByText(navigator.userAgent)).toBeInTheDocument();
  });

  it('ends this browser‘s session at the identity provider', async () => {
    claims.value = { sessionId: 'abc-123', preferredUsername: 'j.okafor', issuedAt: ISSUED, expiresAt: EXPIRES };
    const user = userEvent.setup();

    renderScreen(<Sessions />, { authenticated: true, isStaff: true });
    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('offers no sign-out to a browser holding no session', () => {
    claims.value = { sessionId: '', preferredUsername: '', issuedAt: undefined, expiresAt: undefined };

    renderScreen(<Sessions />);

    const row = within(dataRow());
    expect(row.getByText('Not signed in')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
    // A missing claim reads as a dash, not "Invalid Date" or a blank cell.
    expect(row.getAllByText('—')).toHaveLength(3);
  });

  it('says DEMI keeps no session store, so other devices are not listed', () => {
    claims.value = { sessionId: '', preferredUsername: '', issuedAt: undefined, expiresAt: undefined };

    renderScreen(<Sessions />);

    expect(screen.getByText('Not wired')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(2);
  });
});
