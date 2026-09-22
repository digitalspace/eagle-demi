import type { CSSProperties } from 'react';
import { getSessionClaims, logout } from '../api/keycloak';
import { useSession } from '../session/session';

/** The row action reads as a link, in the body link colour rather than the row-action blue. */
const signOutButton: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  color: 'var(--typography-color-link)',
  font: 'var(--typography-bold-small-body)',
  cursor: 'pointer',
};

function epoch(seconds?: number): string {
  return seconds ? new Date(seconds * 1000).toLocaleString('en-CA') : '—';
}

export function Sessions() {
  const { authenticated } = useSession();
  // Read per render, not memoised: the claims change with the session the row is describing.
  const { sessionId = '', issuedAt, expiresAt } = getSessionClaims() ?? {};

  return (
    <>
      <div className="screen-header">
        <div className="screen-header__text">
          <h1>Active sessions</h1>
          <p>What this browser is holding against DEMI, read from the access token.</p>
        </div>
      </div>

      <div className="callout callout--warning">
        <strong>Not wired</strong> — DEMI keeps no session store; tokens are stateless. Only this browser&apos;s
        session is shown.
      </div>

      <section className="panel panel--scroll">
        <table style={{ minWidth: '44rem' }}>
          <thead>
            <tr>
              <th>Device</th>
              <th>Session</th>
              <th>Token issued</th>
              <th>Token expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <div className="cell__title">This browser</div>
                <div className="cell__sub">{navigator.userAgent}</div>
              </td>
              <td className="cell--muted">
                {sessionId ? <code className="cell__mono">{sessionId}</code> : '—'}
              </td>
              <td className="cell--muted cell--nowrap">{epoch(issuedAt)}</td>
              <td className="cell--muted cell--nowrap">{epoch(expiresAt)}</td>
              <td className="cell--right cell--nowrap">
                {authenticated ? (
                  <span className="row-actions">
                    <button type="button" onClick={logout} style={signOutButton}>
                      Sign out
                    </button>
                  </span>
                ) : (
                  <span className="pill pill--neutral">Not signed in</span>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <p className="footnote">
        Sessions live in Keycloak. Signing out here ends this browser&apos;s session at the identity provider;
        sessions on other devices are not listed and cannot be revoked from DEMI.
      </p>
    </>
  );
}
