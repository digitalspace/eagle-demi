import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { ME_TIMEOUT_MS, SessionProvider } from './SessionProvider';
import { useSession } from './session';

/**
 * A stand-in for the real store in api/keycloak.ts, so a spec can end the session the way a failed
 * refresh does and watch what the provider publishes.
 */
const keycloak = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let snapshot = { authenticated: true, userName: 'idir\\jane', roles: ['staff'] };
  return {
    authEnabled: vi.fn(() => true),
    initKeycloak: vi.fn(async () => true),
    getUserName: vi.fn(() => snapshot.userName),
    getVisibleRoles: vi.fn(() => snapshot.roles),
    hasStaffRole: vi.fn(() => false),
    getToken: vi.fn(() => (snapshot.authenticated ? 'staff-token' : undefined)),
    refreshToken: vi.fn(async () => false),
    subscribeAuth: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getAuthSnapshot: () => snapshot,
    setAuth: (next: typeof snapshot) => {
      snapshot = next;
      for (const listener of [...listeners]) listener();
    },
  };
});

vi.mock('../api/keycloak', () => keycloak);

function Probe() {
  const { settled, isStaff, level, staffUi, userName } = useSession();
  if (!settled) return <p>checking</p>;
  return (
    <dl>
      <dd data-testid="staff">{String(isStaff)}</dd>
      <dd data-testid="staff-ui">{String(staffUi)}</dd>
      <dd data-testid="level">{level}</dd>
      <dd data-testid="name">{userName}</dd>
    </dl>
  );
}

const answerMe = (body: unknown, status = 200) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );

async function renderSession() {
  render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  );
  await screen.findByTestId('staff');
}

const SIGNED_IN = { authenticated: true, userName: 'idir\\jane', roles: ['staff'] };
const SIGNED_OUT = { authenticated: false, userName: '', roles: [] };

beforeEach(() => {
  window.__env = { API_PATH: '/api' };
  keycloak.setAuth(SIGNED_IN);
  keycloak.initKeycloak.mockResolvedValue(true);
  keycloak.authEnabled.mockReturnValue(true);
  keycloak.hasStaffRole.mockReturnValue(false);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.__env;
});

describe('the staff gate', () => {
  it('takes the answer from /me', async () => {
    answerMe({ level: 1, staffUi: true });

    await renderSession();

    expect(screen.getByTestId('staff')).toHaveTextContent('true');
    expect(screen.getByTestId('level')).toHaveTextContent('1');
    expect(screen.getByTestId('name')).toHaveTextContent('idir\\jane');
  });

  // The server answers the gate directly: deriving it from the level admitted a compliance caller
  // and locked out staff, who share level 2.
  it('refuses an account /me says is not staff, whatever its level', async () => {
    keycloak.hasStaffRole.mockReturnValue(true);
    answerMe({ level: 2, staffUi: false });

    await renderSession();

    expect(screen.getByTestId('staff')).toHaveTextContent('false');
    expect(screen.getByTestId('staff-ui')).toHaveTextContent('false');
  });

  it('falls back to the token roles when /me refuses to answer', async () => {
    keycloak.hasStaffRole.mockReturnValue(true);
    answerMe({ error: 'nope' }, 500);

    await renderSession();

    expect(screen.getByTestId('staff')).toHaveTextContent('true');
    // Redaction is server-side either way, so the client keeps the anonymous level.
    expect(screen.getByTestId('level')).toHaveTextContent('4');
  });

  it('keeps a real staffer out of nothing when /me hangs past its budget', async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const budget = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(10));
    keycloak.hasStaffRole.mockReturnValue(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: unknown, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
    );

    await renderSession();

    expect(budget).toHaveBeenCalledWith(ME_TIMEOUT_MS);
    expect(screen.getByTestId('staff')).toHaveTextContent('true');
  });

  it('refuses a visitor with no session', async () => {
    keycloak.setAuth(SIGNED_OUT);
    keycloak.initKeycloak.mockResolvedValue(false);
    answerMe({ level: 4 });

    await renderSession();

    expect(screen.getByTestId('staff')).toHaveTextContent('false');
  });

  // Keycloak off is a local-dev configuration, not a permission: the UI opens and the API still
  // returns only the public corpus, because there is no token to send.
  it('opens the app when auth is turned off', async () => {
    keycloak.authEnabled.mockReturnValue(false);
    keycloak.setAuth(SIGNED_OUT);
    keycloak.initKeycloak.mockResolvedValue(false);
    answerMe({ level: 4 });

    await renderSession();

    expect(screen.getByTestId('staff')).toHaveTextContent('true');
  });
});

// A refresh can fail at any moment after the gate opened. When it does, api/keycloak.ts signs the
// store out, and everything downstream has to see it rather than keep rendering staff UI.
describe('losing the session after the gate opened', () => {
  it('closes the staff gate', async () => {
    answerMe({ level: 1, staffUi: true });
    await renderSession();
    expect(screen.getByTestId('staff')).toHaveTextContent('true');

    act(() => keycloak.setAuth(SIGNED_OUT));

    await waitFor(() => expect(screen.getByTestId('staff')).toHaveTextContent('false'));
  });

  it('drops the user off the account menu', async () => {
    answerMe({ level: 1, staffUi: true });
    await renderSession();
    expect(screen.getByTestId('name')).toHaveTextContent('idir\\jane');

    act(() => keycloak.setAuth(SIGNED_OUT));

    await waitFor(() => expect(screen.getByTestId('name')).toBeEmptyDOMElement());
  });
});
