import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GRANTABLE_ROLES,
  grantsWrite,
  keyCounts,
  keyStatus,
  listApiKeys,
  mintApiKey,
  replacementFor,
  revokeApiKey,
  type ApiKey,
  type KeyStatus,
  type MintRequest,
} from '../api/api-keys';
import { checkbox, linkButton, primaryButton, secondaryButton, stack, textInput } from './controls';
import { errorMessage } from '../api/client';

/** Status to pill modifier, from the demo spec's KEY_PILL. */
const PILL: Record<KeyStatus, string> = {
  Active: 'pill--success',
  Expiring: 'pill--warning',
  Expired: 'pill--neutral',
  Revoked: 'pill--neutral',
};

const API_KEYS_QUERY = ['api-keys'];

const SKELETON_ROWS = [1, 2, 3, 4];

function when(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString('en-CA', { day: '2-digit', month: 'short', year: 'numeric' });
}

function scopeLabel(key: ApiKey): string {
  return key.projectScope && key.projectScope.length ? key.projectScope.join(', ') : 'All projects';
}

export function ApiKeys() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: API_KEYS_QUERY, queryFn: listApiKeys });

  const keys = query.data ?? [];
  const counts = keyCounts(keys);
  const loading = query.isFetching;
  /** Nothing fetched yet. A later reload keeps the rows it has rather than falling back to skeletons. */
  const firstLoad = loading && !keys.length;

  const [error, setError] = useState('');
  const [minted, setMinted] = useState('');
  const [copied, setCopied] = useState(false);
  const [mintOpen, setMintOpen] = useState(false);
  const [name, setName] = useState('');
  const [roles, setRoles] = useState<string[]>([]);
  const [scope, setScope] = useState('');
  const [allowWrite, setAllowWrite] = useState(false);

  /** The mint route refuses a write role unless allowWrite is confirmed, so the box only appears then. */
  const needsAllowWrite = grantsWrite(roles);

  const readError = query.error ? errorMessage(query.error) : '';
  const shown = error || readError;

  const reload = () => queryClient.invalidateQueries({ queryKey: API_KEYS_QUERY });

  async function send(req: MintRequest): Promise<boolean> {
    setError('');
    try {
      const created = await mintApiKey(req);
      setMinted(created.key);
      await reload();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    }
  }

  async function drop(id: string): Promise<boolean> {
    setError('');
    try {
      await revokeApiKey(id);
      await reload();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    }
  }

  function toggleRole(role: string) {
    const next = roles.includes(role) ? roles.filter((r) => r !== role) : [...roles, role];
    setRoles(next);
    if (!grantsWrite(next)) setAllowWrite(false);
  }

  function toggleMint() {
    setMintOpen(!mintOpen);
    setError('');
  }

  async function mint() {
    const scoped = scope
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const ok = await send({
      name: name.trim(),
      roles,
      ...(scoped.length ? { projectScope: scoped } : {}),
      ...(needsAllowWrite ? { allowWrite } : {}),
    });
    if (!ok) return;
    setName('');
    setRoles([]);
    setScope('');
    setAllowWrite(false);
    setMintOpen(false);
  }

  async function rotate(key: ApiKey) {
    if (!confirm(`Rotate ${key.name}? A replacement is minted first, then this key is revoked.`)) return;
    // Mint first: a failed revoke must not cost the caller a secret that is shown once.
    if (await send(replacementFor(key))) await drop(key.id);
  }

  async function revoke(key: ApiKey) {
    if (!confirm(`Revoke ${key.name}? It stops authenticating immediately and cannot be restored.`)) return;
    await drop(key.id);
  }

  async function copySecret() {
    try {
      await navigator.clipboard.writeText(minted);
      setCopied(true);
    } catch {
      // Clipboard refused (no permission, or an insecure context). The secret is still on screen.
    }
  }

  function dismiss() {
    setCopied(false);
    setMinted('');
  }

  const statValue = (value: number) =>
    firstLoad ? <span className="skeleton skeleton--text" style={{ width: '2.5rem' }} aria-hidden="true" /> : value;

  return (
    <>
      <div className="screen-header">
        <div className="screen-header__text">
          <h1>API keys</h1>
          <p>
            Registry keys for callers that cannot hold a Keycloak client. Each carries its own roles, project scope,
            expiry and revocation.
          </p>
        </div>
        <button type="button" onClick={toggleMint} style={{ ...primaryButton, whiteSpace: 'nowrap' }}>
          {mintOpen ? 'Cancel' : 'Mint a key'}
        </button>
      </div>

      {shown && <div className="callout callout--warning">{shown}</div>}

      {minted && (
        <div className="callout callout--warning">
          <div className="cell__title">Copy this secret now — it is shown once</div>
          <code
            className="cell__mono"
            style={{ display: 'block', overflowWrap: 'anywhere', margin: 'var(--layout-margin-small) 0' }}
          >
            {minted}
          </code>
          <div className="cell__sub">
            DEMI stores a hash, so a lost key is rotated, not recovered. Send it as{' '}
            <code className="cell__mono">X-Api-Key</code>.
          </div>
          <div className="panel__actions">
            <button type="button" onClick={copySecret} style={primaryButton}>
              {copied ? 'Copied' : 'Copy secret'}
            </button>
            <button type="button" onClick={dismiss} style={secondaryButton}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="stat-grid" aria-busy={firstLoad ? 'true' : undefined}>
        <div className="stat-card">
          <div className="micro-label">Keys</div>
          <div className="stat-card__value">{statValue(counts.total)}</div>
          <div className="stat-card__note">every key ever minted, revoked ones included</div>
        </div>
        <div className="stat-card">
          <div className="micro-label">Active keys</div>
          <div className="stat-card__value">{statValue(counts.active)}</div>
          <div className="stat-card__note">still authenticating</div>
        </div>
        <div className="stat-card">
          <div className="micro-label">Expiring in 30 days</div>
          <div className="stat-card__value">{statValue(counts.expiring)}</div>
          <div className="stat-card__note">mint a replacement before revoking</div>
        </div>
        <div className="stat-card">
          <div className="micro-label">Revoked</div>
          <div className="stat-card__value">{statValue(counts.revoked)}</div>
          <div className="stat-card__note">row kept, so the audit trail survives</div>
        </div>
      </div>

      {mintOpen && (
        <section className="panel panel--padded">
          <h2 className="panel__title panel__title--inline">Mint a key</h2>
          <div style={{ ...stack, marginTop: 'var(--layout-margin-medium)' }}>
            <label style={{ display: 'block' }}>
              <span className="micro-label">Consumer name</span>
              <input
                type="text"
                placeholder="epic-map-frontend"
                value={name}
                onChange={(event) => setName(event.target.value)}
                style={textInput}
              />
            </label>
            <div>
              <span className="micro-label">Roles</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {GRANTABLE_ROLES.map((role) => (
                  <label
                    key={role}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '0.5rem',
                      font: 'var(--typography-regular-small-body)',
                      padding: '2px 0',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={roles.includes(role)}
                      onChange={() => toggleRole(role)}
                      style={checkbox}
                    />
                    <code className="cell__mono">{role}</code>
                  </label>
                ))}
              </div>
            </div>
            <label style={{ display: 'block' }}>
              <span className="micro-label">Project scope, optional</span>
              <input
                type="text"
                placeholder="402, 111"
                value={scope}
                onChange={(event) => setScope(event.target.value)}
                style={textInput}
              />
              <span className="cell__sub">Comma-separated project ids. Left blank, the key is unscoped.</span>
            </label>
            {needsAllowWrite && (
              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '0.5rem',
                  font: 'var(--typography-regular-small-body)',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={allowWrite}
                  onChange={() => setAllowWrite(!allowWrite)}
                  style={checkbox}
                />
                <span>
                  This key may mutate data. A machine writer wants <code className="cell__mono">demi-service-write</code>
                  , not <code className="cell__mono">demi-admin</code>.
                </span>
              </label>
            )}
          </div>
          <div className="panel__actions">
            <button
              type="button"
              disabled={!name.trim() || !roles.length || (needsAllowWrite && !allowWrite)}
              onClick={mint}
              style={primaryButton}
            >
              Mint key
            </button>
          </div>
        </section>
      )}

      <section
        className="panel panel--scroll"
        aria-busy={loading ? 'true' : undefined}
        style={{ opacity: loading && keys.length ? 0.6 : undefined }}
      >
        <h2 className="panel__title">Keys</h2>
        {firstLoad && <p className="visually-hidden">Loading keys…</p>}
        <table style={{ minWidth: '55rem', tableLayout: 'fixed', width: '100%' }}>
          <thead>
            <tr>
              <th style={{ width: '15rem' }}>Consumer</th>
              <th style={{ width: '12rem' }}>Roles</th>
              <th style={{ width: '8rem' }}>Last used</th>
              <th style={{ width: '8rem' }}>Expires</th>
              <th style={{ width: '6rem' }}>Status</th>
              <th style={{ width: '8rem', textAlign: 'right' }} />
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id}>
                <td>
                  <div className="cell__title">{key.name}</div>
                  <div className="cell__sub">
                    <code className="cell__mono" style={{ overflowWrap: 'anywhere' }}>
                      {key.id}
                    </code>
                  </div>
                </td>
                <td>
                  <span className="role-chips">
                    {key.roles.map((role) => (
                      <span key={role} className="role-chip">
                        {role}
                      </span>
                    ))}
                  </span>
                  <div className="cell__sub">{scopeLabel(key)}</div>
                </td>
                <td className="cell--muted cell--nowrap">{when(key.lastUsedAt)}</td>
                <td className="cell--muted cell--nowrap">{when(key.expiresAt)}</td>
                <td className="cell--nowrap">
                  <span className={`pill ${PILL[keyStatus(key)]}`}>{keyStatus(key)}</span>
                </td>
                <td className="cell--right cell--nowrap">
                  {key.revokedAt ? (
                    <span className="cell--muted">—</span>
                  ) : (
                    <span className="row-actions">
                      <button type="button" onClick={() => rotate(key)} style={linkButton}>
                        Rotate
                      </button>
                      <button type="button" onClick={() => revoke(key)} style={linkButton}>
                        Revoke
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {!keys.length &&
              (loading ? (
                SKELETON_ROWS.map((row) => (
                  <tr key={row} aria-hidden="true">
                    <td>
                      <div className="cell__title">
                        <span className="skeleton skeleton--text" style={{ width: '70%' }} />
                      </div>
                      <div className="cell__sub">
                        <span className="skeleton skeleton--text" style={{ width: '90%' }} />
                      </div>
                    </td>
                    <td>
                      <div>
                        <span className="skeleton skeleton--text" style={{ width: '80%' }} />
                      </div>
                      <div className="cell__sub">
                        <span className="skeleton skeleton--text" style={{ width: '50%' }} />
                      </div>
                    </td>
                    <td>
                      <span className="skeleton skeleton--text" style={{ width: '4rem' }} />
                    </td>
                    <td>
                      <span className="skeleton skeleton--text" style={{ width: '4rem' }} />
                    </td>
                    <td>
                      <span className="pill" style={{ padding: 0 }}>
                        <span className="skeleton skeleton--text" style={{ width: '3.5rem' }} />
                      </span>
                    </td>
                    <td className="cell--right">
                      <span className="skeleton skeleton--text" style={{ width: '5rem' }} />
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="cell--muted">
                    No keys have been minted.
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>

      <section className="panel panel--padded">
        <h2 className="panel__title panel__title--inline">Before you mint one</h2>
        <div style={stack}>
          <div>
            <div className="cell__title">Ask for the least privilege that works</div>
            <div className="cell__sub" style={{ overflowWrap: 'anywhere' }}>
              A key minted with <code className="cell__mono">demi-service-read</code> reads everything the ACL allows
              and writes nothing. Write access is a separate role, and no key can reach{' '}
              <code className="cell__mono">/api/admin/*</code>.
            </div>
          </div>
          <div>
            <div className="cell__title">Project scope is orthogonal to privilege</div>
            <div className="cell__sub" style={{ overflowWrap: 'anywhere' }}>
              A scoped key is privileged <em>within those projects</em>. Scope arrives as roles prefixed{' '}
              <code className="cell__mono">project:</code> and narrows the partition, so privilege lifts the role
              predicate but never the project one.
            </div>
          </div>
          <div>
            <div className="cell__title">The secret is shown once</div>
            <div className="cell__sub" style={{ overflowWrap: 'anywhere' }}>
              Format is <code className="cell__mono">{'demi_<env>_<keyId>_<secret>'}</code>, sent as{' '}
              <code className="cell__mono">X-Api-Key</code>. DEMI stores a hash, so a lost key is rotated, not
              recovered.
            </div>
          </div>
          <div>
            <div className="cell__title">Rotate before revoking</div>
            <div className="cell__sub" style={{ overflowWrap: 'anywhere' }}>
              Rotating here mints the replacement, then revokes the old key only once the new one exists — revocation
              takes effect immediately and is recorded in the audit log.
            </div>
          </div>
        </div>
      </section>

      <p className="footnote">
        Never commit a key literal. This repository is public, so a literal in it is a world-readable credential;{' '}
        <code className="cell__mono">ADMIN_API_KEY</code> is break-glass only.
      </p>
    </>
  );
}
