import { useState, type CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router';
import { getSessionClaims } from '../api/keycloak';
import { isMine, useLinks } from '../api/links';
import { useDeleteLasso, useDeleteQuery, useMyData, useSavePrefs, type SavedLasso } from '../api/me';
import { setPendingLasso } from '../map/pending-lasso';
import { savedQuerySummary, savedQueryUrl } from '../search/saved-query';
import { useSession } from '../session/session';
import {
  DEFAULT_PREFS,
  LANDING_OPTIONS,
  PER_PAGE_OPTIONS,
  readPrefs,
  type Prefs,
} from '../shell/prefs';
import { linkButton, secondaryButton } from './controls';
import { dayMonth } from '../dates';

const panelGrid: CSSProperties = { gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' };

const scrollList: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  maxHeight: 260,
  overflowY: 'auto',
};

const rowButton: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  textAlign: 'left',
  cursor: 'pointer',
};

/** The map is a later slice; the container and its label stay so the panel keeps its shape. */
const mapPreview: CSSProperties = {
  height: 260,
  border: 'var(--layout-border-width-small) solid var(--surface-color-border-default)',
  borderRadius: 'var(--layout-border-radius-medium)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0].toUpperCase()).join('') || '—';
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function Workspace() {
  const navigate = useNavigate();
  const { authenticated, roles } = useSession();
  const claims = getSessionClaims();

  const myData = useMyData();
  const links = useLinks(authenticated);
  const deleteLasso = useDeleteLasso();
  const deleteQuery = useDeleteQuery();
  const savePrefs = useSavePrefs();

  const lassos = myData.data?.lassos ?? [];
  const queries = myData.data?.queries ?? [];

  const failure =
    myData.error ?? deleteLasso.error ?? deleteQuery.error ?? savePrefs.error ?? null;

  /** An edit overrides both the server copy and this browser's, as Angular's linkedSignal did. */
  const [edited, setEdited] = useState<Prefs | null>(null);
  const saved = myData.data?.prefs ?? null;
  const [savedSeen, setSavedSeen] = useState(saved);
  // A fresh `/me/data` answer replaces the edit sitting on top of it, which is what linkedSignal
  // does when its source changes.
  if (saved !== savedSeen) {
    setSavedSeen(saved);
    setEdited(null);
  }
  const prefs = edited ?? saved ?? readPrefs();

  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  /** Falls back to the first area, so the preview is filled in as soon as the areas load. */
  const selected: SavedLasso | null =
    lassos.find((area) => area.slug === selectedSlug) ?? lassos[0] ?? null;

  const me = claims?.preferredUsername ?? '';
  const myLinks = (links.data ?? []).filter((link) => isMine(link, me));

  /** One callout describes one write, as Angular's `write()` clears the last failure before sending. */
  function startWrite() {
    deleteLasso.reset();
    deleteQuery.reset();
    savePrefs.reset();
  }

  function save(next: Prefs) {
    startWrite();
    setEdited(next);
    savePrefs.mutate(next);
  }

  /** The map reads this on open, so the shape is already there on arrival. */
  function applyOnMap(area: SavedLasso) {
    setPendingLasso({ ring: area.ring, label: area.name });
    return navigate('/map');
  }

  function removeLasso(area: SavedLasso) {
    startWrite();
    // Deleting the selected area hands the preview to the next one down, or the one above when it
    // was last; deleting any other area leaves the selection where it is.
    if (area.slug === selected?.slug) {
      const index = lassos.findIndex((a) => a.slug === area.slug);
      setSelectedSlug((lassos[index + 1] ?? lassos[index - 1])?.slug ?? null);
    }
    deleteLasso.mutate(area.slug);
  }

  return (
    <>
      <div className="screen-header">
        <div className="screen-header__text">
          <h1>My account</h1>
          <p>
            Everything DEMI keeps for you: saved map areas, saved queries, your short links, and the preferences that
            follow you to another browser.
          </p>
        </div>
      </div>

      {!authenticated && (
        <div className="callout callout--warning">
          Not signed in. Sign in with an IDIR account to see your saved areas, queries and links.
        </div>
      )}

      {failure && <div className="callout callout--warning">{message(failure)}</div>}

      <div className="panel-grid" style={panelGrid}>
        <section className="panel panel--padded">
          <h2 className="panel__title panel__title--inline">Identity</h2>
          {authenticated ? (
            <>
              <div className="identity">
                <span className="identity__avatar" aria-hidden="true">
                  {initialsOf(claims?.name ?? '')}
                </span>
                <span>
                  <span className="identity__name" style={{ display: 'block' }}>
                    {claims?.name || '—'}
                  </span>
                  <code className="cell__mono">{claims?.idirUsername || claims?.preferredUsername || '—'}</code>
                </span>
              </div>
              <div className="kv-grid" style={{ gridTemplateColumns: '1fr' }}>
                <div className="kv-row">
                  <span className="kv-row__key">Email</span>
                  <span className="kv-row__value">{claims?.email || '—'}</span>
                </div>
                {!!claims?.groups?.length && (
                  <div className="kv-row">
                    <span className="kv-row__key">Groups</span>
                    <span className="kv-row__value">{claims.groups.join(', ')}</span>
                  </div>
                )}
              </div>
              <div className="micro-label" style={{ marginBottom: 'var(--layout-margin-xsmall)' }}>
                Roles
              </div>
              {roles.length ? (
                <span className="role-chips">
                  {roles.map((role) => (
                    <span className="role-chip" key={role}>
                      {role}
                    </span>
                  ))}
                </span>
              ) : (
                <p className="cell__sub" style={{ margin: 0 }}>
                  None beyond the Keycloak defaults.
                </p>
              )}
              <p className="footnote" style={{ marginBottom: 0 }}>
                Identity comes from Keycloak. To change a role or group, ask an administrator.
              </p>
            </>
          ) : (
            <p className="panel__lede" style={{ marginBottom: 0 }}>
              Sign in to see the identity DEMI reads from your token.
            </p>
          )}
        </section>

        <section className="panel panel--padded">
          <h2 className="panel__title panel__title--inline">Preferences</h2>
          <div className="kv-grid">
            <div className="kv-row">
              <span className="kv-row__key">
                <label htmlFor="pref-landing">Default landing screen</label>
              </span>
              <span className="kv-row__value">
                <select
                  id="pref-landing"
                  value={prefs.landing}
                  onChange={(event) => save({ ...prefs, landing: event.target.value })}
                >
                  {LANDING_OPTIONS.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </span>
            </div>
            <div className="kv-row">
              <span className="kv-row__key">
                <label htmlFor="pref-per-page">Results per page</label>
              </span>
              <span className="kv-row__value">
                <select
                  id="pref-per-page"
                  value={String(prefs.perPage)}
                  onChange={(event) => save({ ...prefs, perPage: Number(event.target.value) })}
                >
                  {PER_PAGE_OPTIONS.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </span>
            </div>
          </div>
          <div className="panel__actions" style={{ display: 'flex', gap: 'var(--layout-margin-small)' }}>
            <button type="button" onClick={() => save({ ...DEFAULT_PREFS })} style={secondaryButton}>
              Reset to defaults
            </button>
          </div>
        </section>
      </div>

      <section className="panel panel--padded">
        <h2 className="panel__title panel__title--inline">Saved map areas</h2>
        <p className="panel__lede">Areas drawn with the lasso on Map Explorer. Only you can see them.</p>
        {lassos.length ? (
          <div className="panel-grid" style={{ ...panelGrid, marginBottom: 0 }}>
            <ul style={scrollList}>
              {lassos.map((area) => (
                <li
                  key={area.slug}
                  className={`kv-row${area.slug === selected?.slug ? ' kv-row--selected' : ''}`}
                  style={{ padding: '6px 8px', alignItems: 'center' }}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedSlug(area.slug)}
                    aria-current={area.slug === selected?.slug ? 'true' : undefined}
                    style={rowButton}
                  >
                    <span className="cell__title" style={{ display: 'block' }}>
                      {area.name}
                    </span>
                    <span className="cell__sub">
                      {area.ring.length} points · {dayMonth(area.updatedAt)}
                    </span>
                  </button>
                  <span className="row-actions">
                    <button type="button" onClick={() => applyOnMap(area)} style={linkButton}>
                      Apply on map
                    </button>
                    <button type="button" onClick={() => removeLasso(area)} style={linkButton}>
                      Delete
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            {/* role="group", not img: the container is a live map whose children stay reachable. */}
            <div role="group" aria-label={`Map of ${selected?.name}`} style={mapPreview}>
              <span className="cell__sub">Map preview</span>
            </div>
          </div>
        ) : (
          <p className="cell__sub" style={{ margin: 0 }}>
            {myData.isFetching ? (
              'Loading…'
            ) : (
              <>
                Draw a lasso on <Link to="/map">Map Explorer</Link> and save it to keep it here.
              </>
            )}
          </p>
        )}
      </section>

      <section className="panel panel--padded">
        <h2 className="panel__title panel__title--inline">
          Saved queries <span className="pill pill--info">{queries.length}</span>
        </h2>
        <p className="panel__lede">
          Searches you saved on <Link to="/search">Search</Link>. Only you can see them.
        </p>
        <ul style={scrollList}>
          {queries.length ? (
            queries.map((query) => (
              <li key={query.slug} className="kv-row" style={{ padding: '6px 8px', alignItems: 'center' }}>
                <span>
                  <span className="cell__title" style={{ display: 'block' }}>
                    {query.name}
                  </span>
                  <span className="cell__sub">
                    {savedQuerySummary(query)} · {dayMonth(query.savedAt)}
                  </span>
                </span>
                <span className="row-actions">
                  <button
                    type="button"
                    onClick={() => navigate(savedQueryUrl(query))}
                    aria-label={`Open ${query.name} in search`}
                    style={linkButton}
                  >
                    Open in search
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      startWrite();
                      deleteQuery.mutate(query.slug);
                    }}
                    aria-label={`Delete ${query.name}`}
                    style={linkButton}
                  >
                    Delete
                  </button>
                </span>
              </li>
            ))
          ) : (
            <li className="cell__sub" style={{ listStyle: 'none' }}>
              {myData.isFetching ? (
                'Loading…'
              ) : (
                <>
                  Run a search on <Link to="/search">Search</Link> and save it to keep it here.
                </>
              )}
            </li>
          )}
        </ul>
      </section>

      <section className="panel panel--padded">
        <h2 className="panel__title panel__title--inline">My short links</h2>
        <p className="panel__lede">
          Short URLs you created. Repoint or delete them on <Link to="/links">Short URLs</Link>.
        </p>
        <div className="kv-grid">
          {myLinks.length ? (
            myLinks.map((link) => (
              <div className="kv-row" key={link.id}>
                <span className="kv-row__key">
                  <a href={link.shortUrl} target="_blank" rel="noopener noreferrer">
                    <code className="cell__mono">{link.shortUrl}</code>
                  </a>
                  {link.personal && (
                    <span className="pill pill--info" style={{ marginLeft: '0.35rem' }}>
                      Personal
                    </span>
                  )}
                </span>
                <span className="kv-row__value cell--truncate cell--muted">{link.note || link.url}</span>
              </div>
            ))
          ) : (
            <p className="cell__sub" style={{ margin: 0 }}>
              {links.isFetching ? (
                'Loading…'
              ) : (
                <>
                  Create one on <Link to="/links">Short URLs</Link> and mark it Personal.
                </>
              )}
            </p>
          )}
        </div>
      </section>

      <p className="footnote">
        Saved areas and saved queries are stored with your account. Preferences are stored with your account and in
        this browser; signed out, only the browser copy is used. Short links are readable by anyone holding the URL;
        marking one personal only keeps it off other people&apos;s lists.
      </p>
    </>
  );
}
