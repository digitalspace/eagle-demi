import { createContext, useContext } from 'react';

export interface Session {
  /** False until Keycloak and `GET /me` have both settled. */
  settled: boolean;
  authenticated: boolean;
  userName: string;
  /** Realm roles from the token, Keycloak's own boilerplate removed. */
  roles: string[];
  /** Visibility level from `GET /me`: 0 most privileged, 4 anonymous. */
  level: number;
  /** The server's own answer to "may this caller see staff-only things". */
  staffUi: boolean;
  /**
   * THE one answer to "may this person see staff-only things": authenticated and not refused.
   *
   * Keycloak off is a local-dev configuration, not a permission. The UI opens so the app is
   * workable offline; the API still returns the public corpus, because there is no token to send.
   */
  isStaff: boolean;
}

/** Level 4 by default, so nothing renders privileged UI while `/me` is in flight. */
export const ANONYMOUS_SESSION: Session = {
  settled: false,
  authenticated: false,
  userName: '',
  roles: [],
  level: 4,
  staffUi: false,
  isStaff: false,
};

export const SessionContext = createContext<Session>(ANONYMOUS_SESSION);

export function useSession(): Session {
  return useContext(SessionContext);
}
