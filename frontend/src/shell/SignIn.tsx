import type { CSSProperties } from 'react';
import { config } from '../config';
import { login, logout } from '../api/keycloak';
import { useSession } from '../session/session';

const page: CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--surface-color-primary-default)',
};
const stripe: CSSProperties = { height: '4px', background: 'var(--theme-primary-gold)' };
const centre: CSSProperties = {
  flex: 1,
  display: 'grid',
  placeItems: 'center',
  padding: 'var(--layout-padding-large)',
};
const panel: CSSProperties = {
  textAlign: 'center',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 'var(--layout-margin-medium)',
  maxWidth: '30rem',
};
const mark: CSSProperties = { height: '76px', width: 'auto' };
const title: CSSProperties = {
  font: 'var(--typography-bold-h2)',
  color: 'var(--surface-color-background-white)',
  margin: 0,
};
const tagline: CSSProperties = {
  font: 'var(--typography-regular-body)',
  color: 'var(--eao-on-dark-muted)',
  margin: 0,
};
const signIn: CSSProperties = {
  marginTop: 'var(--layout-margin-small)',
  background: 'var(--theme-primary-gold)',
  color: 'var(--surface-color-primary-default)',
  border: 'none',
  borderRadius: 'var(--layout-border-radius-small)',
  padding: '0.8rem 1.6rem',
  font: 'var(--typography-bold-body)',
  cursor: 'pointer',
};
const rejectedText: CSSProperties = {
  font: 'var(--typography-regular-small-body)',
  color: 'var(--theme-primary-gold)',
  margin: 0,
  maxWidth: '24rem',
};
const signOut: CSSProperties = {
  background: 'none',
  border: 'var(--layout-border-width-small) solid var(--theme-primary-gold)',
  color: 'var(--theme-primary-gold)',
  borderRadius: 'var(--layout-border-radius-small)',
  padding: '0.4rem 1rem',
  font: 'var(--typography-bold-small-body)',
  cursor: 'pointer',
};
const footer: CSSProperties = {
  padding: 'var(--layout-padding-small) var(--layout-padding-large)',
  borderTop: '2px solid var(--theme-primary-gold)',
  display: 'flex',
  justifyContent: 'space-between',
  font: 'var(--typography-regular-label)',
  color: 'var(--eao-on-dark-muted)',
};

export function SignIn() {
  const c = config();
  const { authenticated, staffUi } = useSession();
  // Signed in but role-less: Keycloak accepted the account, DEMI did not.
  const rejected = authenticated && !staffUi;

  return (
    <div style={page}>
      <div style={stripe}></div>
      <div style={centre}>
        <div style={panel}>
          <img
            src="/assets/bcgov-header-vert.png"
            alt="Government of British Columbia"
            style={mark}
          />
          <h1 style={title}>DEMI</h1>
          <p style={tagline}>Digital File Library &amp; Document Registry</p>
          <button type="button" onClick={() => login()} style={signIn}>
            Sign in
          </button>
          {rejected && (
            <>
              <p style={rejectedText}>
                That account signed in successfully but carries no EPIC staff role, so DEMI signed
                it back out. Ask an administrator for the <code>staff</code> role.
              </p>
              <button type="button" onClick={() => logout()} style={signOut}>
                Sign out
              </button>
            </>
          )}
        </div>
      </div>
      <div style={footer}>
        <span>Keycloak realm {c.KEYCLOAK_REALM || 'eao-epic'}</span>
        <span>{c.ENVIRONMENT}</span>
      </div>
    </div>
  );
}
