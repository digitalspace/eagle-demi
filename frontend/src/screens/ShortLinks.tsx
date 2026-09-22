import { Fragment, useState, type CSSProperties } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  LINKS_QUERY,
  createLink,
  isMine,
  removeLink,
  repointLink,
  useLinks,
  type ShortLink,
} from '../api/links';
import { getSessionClaims } from '../api/keycloak';
import { errorMessage } from '../api/client';
import { linkButton, primaryButton, stack, textInput } from './controls';
import { dayMonth } from '../dates';

const SKELETON_ROWS = [1, 2, 3, 4];

const cancelButton: CSSProperties = { ...linkButton, color: 'var(--typography-color-secondary)' };

/** The narrower input a row swaps in while its destination is being repointed. */
const editInput: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '0.35rem 0.6rem',
  border: 'var(--layout-border-width-small) solid var(--surface-color-border-default)',
  borderRadius: 'var(--layout-border-radius-small)',
  font: 'var(--typography-regular-small-body)',
};

/** Mine first, then everyone's. Empty groups are dropped rather than shown as a bare heading. */
function linkGroups(links: ShortLink[], me: string): { title: string; rows: ShortLink[] }[] {
  const mine = links.filter((link) => isMine(link, me));
  const shared = links.filter((link) => !mine.includes(link));
  return [
    { title: 'My links', rows: mine },
    { title: 'Shared links', rows: shared },
  ].filter((group) => group.rows.length > 0);
}

export function ShortLinks() {
  const queryClient = useQueryClient();
  const query = useLinks();

  const links = query.data ?? [];
  const loading = query.isFetching;
  const groups = linkGroups(links, getSessionClaims()?.preferredUsername ?? '');

  const [error, setError] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [newCode, setNewCode] = useState('');
  const [newNote, setNewNote] = useState('');
  const [newPersonal, setNewPersonal] = useState(false);

  /** Code of the row being repointed, '' when none. */
  const [editingCode, setEditingCode] = useState('');
  const [editUrl, setEditUrl] = useState('');

  /** The row the clipboard last answered for, and what it said. */
  const [copy, setCopy] = useState<{ code: string; ok: boolean } | null>(null);

  /** The read failure already dismissed, so a later one is shown again rather than swallowed. */
  const [dismissedRead, setDismissedRead] = useState<unknown>(null);

  const readError = query.error && query.error !== dismissedRead ? errorMessage(query.error) : '';
  const shown = error || readError;

  const reload = () => queryClient.invalidateQueries({ queryKey: LINKS_QUERY });

  async function write(send: () => Promise<unknown>): Promise<boolean> {
    setError('');
    try {
      await send();
      await reload();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    }
  }

  /** Opening or closing the form clears the callout, whichever read or write put it there. */
  function toggleForm() {
    setFormOpen(!formOpen);
    setError('');
    setDismissedRead(query.error ?? null);
  }

  async function submit() {
    const url = newUrl.trim();
    if (!url) return;
    const created = await write(() => createLink(url, newNote.trim(), newCode.trim(), newPersonal));
    if (!created) return;
    setNewUrl('');
    setNewCode('');
    setNewNote('');
    setNewPersonal(false);
    setFormOpen(false);
  }

  function startRepoint(link: ShortLink) {
    setEditingCode(link.id);
    setEditUrl(link.url);
    setError('');
  }

  async function saveRepoint(code: string) {
    const url = editUrl.trim();
    if (!url) return;
    if (await write(() => repointLink(code, url))) setEditingCode('');
  }

  async function remove(link: ShortLink) {
    if (!confirm(`Delete ${link.shortUrl}? Anything already printed with this link stops working.`)) return;
    await write(() => removeLink(link.id));
  }

  async function copyLink(link: ShortLink) {
    try {
      await navigator.clipboard.writeText(link.shortUrl);
      setCopy({ code: link.id, ok: true });
    } catch {
      // Clipboard refused (no permission, or an insecure context). The short URL is still on screen.
      setCopy({ code: link.id, ok: false });
    }
  }

  return (
    <>
      <div className="screen-header">
        <div className="screen-header__text">
          <h1>Short URLs</h1>
          <p>Permanent links DEMI issues for posters, campaigns and staff sharing.</p>
        </div>
        <button type="button" onClick={toggleForm} style={primaryButton}>
          {formOpen ? 'Cancel' : 'New short link'}
        </button>
      </div>

      {shown && <div className="callout callout--warning">{shown}</div>}

      {formOpen && (
        <section className="panel panel--padded">
          <h2 className="panel__title panel__title--inline">New short link</h2>
          <div style={{ ...stack, marginTop: 'var(--layout-margin-medium)' }}>
            <label style={{ display: 'block' }}>
              <span className="micro-label">Destination</span>
              <input
                type="url"
                placeholder="https://projects.eao.gov.bc.ca/…"
                value={newUrl}
                onChange={(event) => setNewUrl(event.target.value)}
                style={textInput}
              />
            </label>
            <label style={{ display: 'block' }}>
              <span className="micro-label">Custom code, optional</span>
              <input
                type="text"
                placeholder="site-c-eac"
                value={newCode}
                onChange={(event) => setNewCode(event.target.value)}
                style={textInput}
              />
              <span className="cell__sub">
                3–64 characters of a–z, 0–9, hyphen or underscore. Left blank, DEMI generates one.
              </span>
            </label>
            <label style={{ display: 'block' }}>
              <span className="micro-label">Note</span>
              <input
                type="text"
                placeholder="Where this link is being used"
                value={newNote}
                onChange={(event) => setNewNote(event.target.value)}
                style={textInput}
              />
            </label>
            <div>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  font: 'var(--typography-regular-body)',
                  cursor: 'pointer',
                }}
              >
                <input type="checkbox" checked={newPersonal} onChange={() => setNewPersonal(!newPersonal)} />
                Personal (only visible to me)
              </label>
              <span className="cell__sub">Anyone with the short URL can still open it.</span>
            </div>
          </div>
          <div className="panel__actions">
            <button type="button" disabled={!newUrl.trim()} onClick={() => void submit()} style={primaryButton}>
              Create link
            </button>
          </div>
        </section>
      )}

      <section
        className="panel panel--scroll"
        aria-busy={loading ? 'true' : undefined}
        style={{ opacity: loading && links.length ? 0.6 : undefined }}
      >
        {loading && !links.length && <p className="visually-hidden">Loading short links…</p>}
        <table style={{ minWidth: '52rem', tableLayout: 'fixed', width: '100%' }}>
          <thead>
            <tr>
              <th style={{ width: '15rem' }}>Short link</th>
              <th style={{ width: '15rem' }}>Destination</th>
              <th style={{ width: '13rem' }}>Note</th>
              <th style={{ width: '7rem' }}>Created by</th>
              <th style={{ width: '5.5rem' }}>Created</th>
              <th style={{ width: '10rem', textAlign: 'right' }} />
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <Fragment key={group.title}>
                <tr>
                  <th
                    colSpan={6}
                    scope="colgroup"
                    className="micro-label"
                    style={{ textAlign: 'left', background: 'var(--surface-color-background-light-gray)' }}
                  >
                    {group.title}
                  </th>
                </tr>
                {group.rows.map((link) => (
                  <tr key={link.id}>
                    <td>
                      <a href={link.shortUrl} target="_blank" rel="noopener noreferrer">
                        <code className="cell__mono" style={{ overflowWrap: 'anywhere', color: 'inherit' }}>
                          {link.shortUrl}
                        </code>
                      </a>
                      {link.personal && (
                        <span className="pill pill--info" style={{ marginLeft: '0.35rem' }}>
                          Personal
                        </span>
                      )}
                    </td>
                    <td className="cell--truncate cell--muted">
                      {editingCode === link.id ? (
                        <input
                          type="url"
                          aria-label="New destination"
                          value={editUrl}
                          onChange={(event) => setEditUrl(event.target.value)}
                          style={editInput}
                        />
                      ) : (
                        link.url
                      )}
                    </td>
                    <td>{link.note || '—'}</td>
                    <td className="cell--muted">{link.createdBy}</td>
                    <td className="cell--muted cell--nowrap">{dayMonth(link.createdAt) || '—'}</td>
                    <td className="cell--right cell--nowrap">
                      <span className="row-actions">
                        {editingCode === link.id ? (
                          <>
                            <button type="button" onClick={() => void saveRepoint(link.id)} style={linkButton}>
                              Save
                            </button>
                            <button type="button" onClick={() => setEditingCode('')} style={cancelButton}>
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button type="button" onClick={() => void copyLink(link)} style={linkButton}>
                              {copy?.code === link.id ? (copy.ok ? 'Copied' : 'Copy failed') : 'Copy'}
                            </button>
                            <button type="button" onClick={() => startRepoint(link)} style={linkButton}>
                              Repoint
                            </button>
                            <button type="button" onClick={() => void remove(link)} style={linkButton}>
                              Delete
                            </button>
                          </>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
            {!groups.length &&
              (loading ? (
                SKELETON_ROWS.map((row) => (
                  <tr key={row} aria-hidden="true">
                    <td>
                      <span className="skeleton skeleton--text" style={{ width: '90%' }} />
                    </td>
                    <td>
                      <span className="skeleton skeleton--text" style={{ width: '85%' }} />
                    </td>
                    <td>
                      <span className="skeleton skeleton--text" style={{ width: '70%' }} />
                    </td>
                    <td>
                      <span className="skeleton skeleton--text" style={{ width: '60%' }} />
                    </td>
                    <td>
                      <span className="skeleton skeleton--text" style={{ width: '3rem' }} />
                    </td>
                    <td className="cell--right">
                      <span className="skeleton skeleton--text" style={{ width: '6rem' }} />
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="cell--muted">
                    No short links yet.
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>

      <p className="footnote">
        Short links are permanent and redirect without caching, so a repointed link takes effect on the next click
        — including on links already printed. Deleting one is not reversible; the audit trail keeps the record.
      </p>
    </>
  );
}
