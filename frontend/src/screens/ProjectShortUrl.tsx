import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, errorMessage, serverError } from '../api/client';
import { STAFF_ROLES } from '../api/keycloak';
import { LINKS_QUERY } from '../api/links';
import {
  SHORT_CODE_PATTERN,
  projectFactsKey,
  saveShortCode,
  type ProjectFacts,
} from '../api/project-summary';
import { useSession } from '../session/session';
import { primaryButton, secondaryButton } from './controls';

const INVALID = 'Use 3 to 64 characters: lowercase letters, numbers, hyphens or underscores.';
const TAKEN = 'That short URL is taken.';
/** A 400 about the project, not the code the user typed, so it is not a field error. */
const PROJECT_REFUSAL = /eagle id/i;
const COPY_FEEDBACK_MS = 2000;

/** The body's `error`, else its `message`, else null. */
function serverText(err: ApiError): string | null {
  const error = serverError(err.body);
  if (error) return error;
  try {
    const { message } = JSON.parse(err.body) as { message?: unknown };
    return typeof message === 'string' && message ? message : null;
  } catch {
    return null;
  }
}

/** The project's `/s/<code>` link, with an inline editor for staff who may write. */
export function ProjectShortUrl({ projectId, facts }: { projectId: string; facts: ProjectFacts }) {
  const { isStaff, roles } = useSession();
  // Same roles as the API's requireAdmin. Keycloak off (local dev) leaves `roles` empty, so Edit stays hidden there.
  const canEdit = isStaff && roles.some((role) => STAFF_ROLES.includes(role));
  const queryClient = useQueryClient();
  const id = useId();
  const editButton = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  /** Set on Save or Cancel only, so the first render does not pull focus to Edit. */
  const refocusEdit = useRef(false);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [touched, setTouched] = useState(false);
  const [rejected, setRejected] = useState('');
  const [failure, setFailure] = useState('');
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState<boolean | null>(null);

  const close = useCallback(() => {
    refocusEdit.current = true;
    setFailure('');
    setEditing(false);
  }, []);

  useEffect(() => {
    if (editing) input.current?.focus();
    else if (refocusEdit.current) {
      refocusEdit.current = false;
      editButton.current?.focus();
    }
  }, [editing]);

  // Bound natively, as ProjectSummary does for its dialog: a JSX key handler on <form> fails jsx-a11y.
  useEffect(() => {
    const element = form.current;
    if (!element || saving) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    };
    element.addEventListener('keydown', onKeyDown);
    return () => element.removeEventListener('keydown', onKeyDown);
  }, [editing, saving, close]);

  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => setCopied(null), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const { shortCode, shortUrl } = facts;
  if (!shortCode || !shortUrl) return null;

  const bare = shortUrl.replace(/^https?:\/\//, '');
  // Null when the URL does not end in the code, so nothing is built from a wrong prefix.
  const prefix = bare.endsWith(shortCode) ? bare.slice(0, bare.length - shortCode.length) : null;
  const legacy = facts.legacyShortCodes ?? [];
  const invalid = !SHORT_CODE_PATTERN.test(draft);
  const unchanged = draft === shortCode;
  const showInvalid = invalid && (touched || (draft !== '' && !unchanged));
  const fieldError = showInvalid ? INVALID : rejected;
  const codeId = `${id}-code`;
  const prefixId = `${id}-prefix`;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;

  const open = () => {
    setDraft(shortCode);
    setTouched(false);
    setRejected('');
    setFailure('');
    setEditing(true);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shortUrl);
      setCopied(true);
    } catch {
      // Clipboard refused (no permission, or an insecure context). The URL is still on screen.
      setCopied(false);
    }
  };

  async function save() {
    setTouched(true);
    if (invalid || unchanged || saving) return;
    setSaving(true);
    setRejected('');
    setFailure('');
    try {
      // The route may carry an Eagle ObjectId; the write goes to the DEMI id.
      const saved = await saveShortCode(String(facts.id), draft);
      await queryClient.cancelQueries({ queryKey: projectFactsKey(projectId) });
      queryClient.setQueryData<ProjectFacts>(projectFactsKey(projectId), (old) => old && { ...old, ...saved });
      void queryClient.invalidateQueries({ queryKey: LINKS_QUERY });
      close();
    } catch (err) {
      const text = err instanceof ApiError ? serverText(err) : null;
      const status = err instanceof ApiError ? err.status : 0;
      if (status === 409) setRejected(TAKEN);
      else if (status === 400 && text && !PROJECT_REFUSAL.test(text)) setRejected(text);
      else setFailure(text ?? errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ps-short">
      {failure && (
        <div className="callout callout--warning" role="alert">
          <p>{failure}</p>
        </div>
      )}

      {editing ? (
        <form
          className="ps-short__form"
          ref={form}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label className="micro-label" htmlFor={codeId}>
            Short URL
          </label>
          <div className="ps-short__field">
            <span id={prefixId} className="ps-short__prefix">
              {prefix ?? '/s/'}
            </span>
            <input
              ref={input}
              id={codeId}
              type="text"
              className="ps-short__input"
              autoComplete="off"
              spellCheck={false}
              value={draft}
              aria-invalid={fieldError ? true : undefined}
              // Stable list: the error node is always present, so a change reads once, through aria-live.
              aria-describedby={`${prefixId} ${errorId} ${helpId}`}
              onBlur={() => setTouched(true)}
              onChange={(event) => {
                setDraft(event.target.value.toLowerCase());
                setRejected('');
              }}
            />
          </div>
          <p id={errorId} className="ps-short__error" aria-live="polite">
            {fieldError}
          </p>
          <p id={helpId} className="ps-short__help">
            The old link will keep working and will open this project.
          </p>
          <div className="ps-short__actions">
            <button type="submit" disabled={saving || unchanged} style={primaryButton}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={close} disabled={saving} style={secondaryButton}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <p className="ps__meta">
          <span>
            Short URL:{' '}
            <a href={shortUrl} target="_blank" rel="noopener noreferrer">
              <code className="cell__mono">{prefix === null ? shortUrl : bare}</code>
            </a>
          </span>
          <button type="button" className="ps-card__link ps-card__link--button" onClick={() => void copy()}>
            Copy <span className="visually-hidden">short URL</span>
          </button>
          <span role="status">{copied === null ? '' : copied ? 'Copied' : 'Copy failed'}</span>
          {canEdit && (
            <button
              ref={editButton}
              type="button"
              className="ps-card__link ps-card__link--button"
              onClick={open}
            >
              Edit <span className="visually-hidden">short URL</span>
            </button>
          )}
        </p>
      )}

      {legacy.length > 0 && (
        <p className="ps-short__help">
          Also works: {legacy.map((code) => (prefix === null ? code : `${prefix}${code}`)).join(', ')}
        </p>
      )}
    </div>
  );
}
