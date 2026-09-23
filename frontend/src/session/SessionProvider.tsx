import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { READ_TIMEOUT_MS, api } from '../api/client';
import {
  authEnabled,
  getAuthSnapshot,
  getUserName,
  getVisibleRoles,
  hasStaffRole,
  initKeycloak,
  subscribeAuth,
} from '../api/keycloak';
import { SessionContext, type Session } from './session';

/** Budget for `GET /me`. The gate waits on this read, so a hung API must not hold it open. */
export const ME_TIMEOUT_MS = READ_TIMEOUT_MS;

interface Me {
  level?: unknown;
  staffUi?: unknown;
}

/** What `GET /me` said. `staffUi` stays null when it could not answer, so the fallback re-derives. */
interface MeState {
  settled: boolean;
  level: number;
  staffUi: boolean | null;
}

const PENDING: MeState = { settled: false, level: 4, staffUi: null };

async function loadMe(): Promise<MeState> {
  let level = 4;
  let staffUi: boolean | null = null;

  try {
    const me = await api<Me>('/me', { timeoutMs: ME_TIMEOUT_MS });
    if (typeof me?.level === 'number') level = me.level;
    // The server answers the gate directly. Deriving it here from level/tier admitted a
    // compliance caller and locked out staff, who share level 2 and tier 'public'.
    if (typeof me?.staffUi === 'boolean') staffUi = me.staffUi;
  } catch (err) {
    console.warn('[session] /me unavailable, falling back to token roles', err);
  }

  return { settled: true, level, staffUi };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  // Auth is subscribed, not read once: a refresh can fail at any moment, and when it does the gate
  // has to drop to sign-in rather than keep rendering staff UI over a session the API has ended.
  const auth = useSyncExternalStore(subscribeAuth, getAuthSnapshot);
  const [me, setMe] = useState<MeState>(PENDING);

  useEffect(() => {
    let live = true;
    void (async () => {
      const authenticated = await initKeycloak();
      if (!live) return;
      // No session and auth is required: the gate shows sign-in from the token alone, so /me
      // would just be a wasted round trip against an endpoint that needs a bearer token anyway.
      if (!authenticated && authEnabled()) {
        setMe({ settled: true, level: 4, staffUi: null });
        return;
      }
      const loaded = await loadMe();
      if (live) setMe(loaded);
    })();
    return () => {
      live = false;
    };
  }, []);

  // A hung or refusing /me must not lock a real staffer out; redaction is server-side either way,
  // so the client keeps level 4 and only the UI gate falls back to the token roles.
  const staffUi = me.staffUi ?? hasStaffRole();

  const session: Session = {
    settled: me.settled,
    authenticated: auth.authenticated,
    userName: getUserName(),
    roles: getVisibleRoles(),
    level: me.level,
    staffUi,
    isStaff: authEnabled() ? auth.authenticated && staffUi : true,
  };

  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}
