import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, errorMessage, serverError } from '../api/client';
import { STAFF_ROLES } from '../api/keycloak';
import { LINKS_QUERY } from '../api/links';
import {
  PROJECT_FACTS_QUERY,
  SHORT_CODE_PATTERN,
  projectFactsKey,
  saveShortCode,
  type ProjectFacts,
  type ShortCodeChange,
} from '../api/project-summary';
import { useSession } from '../session/session';
import { primaryButton, secondaryButton } from './controls';

const INVALID = 'Use 3 to 64 characters: lowercase letters, numbers, hyphens or underscores.';
const INVALID_URL = 'Enter a full web address that starts with https://.';
const TAKEN = 'That short URL is taken.';
/** A 400 about the project, not the code the user typed, so it is not a field error. */
const PROJECT_REFUSAL = /eagle id/i;
/** The API words every refused destination as "url ...". */
const URL_REFUSAL = /^url\b/i;
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

/** Empty is valid: it means the project page. The API takes https only. */
function isWebAddress(value: string): boolean {
  if (!value) return true;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** The project's `/s/<code>` link and where it points, with an inline editor for staff who may write. */
export function ProjectShortUrl({ projectId, facts }: { projectId: string; facts: ProjectFacts }) {
  const { isStaff, roles } = useSession();
  // Same roles as the API's requireAdmin. Keycloak off (local dev) leaves `roles` empty, so Edit stays hidden there.
  const canEdit = isStaff && roles.some((role) => STAFF_ROLES.includes(role));
  const queryClient = useQueryClient();
  const id = useId();
  const editButton = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  /** Set on Save or Cancel only, so the first render does not pull focus to Edit. */
  const refocusEdit = useRef(false);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [urlDraft, setUrlDraft] = useState('');
  const [touched, setTouched] = useState(false);
  const [urlTouched, setUrlTouched] = useState(false);
  const [rejected, setRejected] = useState('');
  const [urlRejected, setUrlRejected] = useState('');
  const [failure, setFailure] = useState('');
  const [saving, setSaving] = useState(false);
  /** Set by a 503: the re-read can match the drafts, and a PUT of the same values still has records to move. */
  const [retry, setRetry] = useState(false);
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
  const target = facts.shortLinkUrl ?? '';
  // The field holds only a custom target; empty is the project page.
  const storedTarget = facts.shortLinkCustom ? target : '';
  const url = urlDraft.trim();
  const codeChanged = draft !== shortCode;
  const urlChanged = url !== storedTarget;
  const canSave = codeChanged || urlChanged || retry;
  const invalid = !SHORT_CODE_PATTERN.test(draft);
  const urlInvalid = !isWebAddress(url);
  const showInvalid = invalid && (touched || (draft !== '' && codeChanged));
  const fieldError = showInvalid ? INVALID : rejected;
  const urlError = urlInvalid && urlTouched ? INVALID_URL : urlRejected;
  const codeId = `${id}-code`;
  const prefixId = `${id}-prefix`;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const urlId = `${id}-url`;
  const urlHelpId = `${id}-url-help`;
  const urlErrorId = `${id}-url-error`;

  const open = () => {
    setDraft(shortCode);
    setUrlDraft(storedTarget);
    setTouched(false);
    setUrlTouched(false);
    setRejected('');
    setUrlRejected('');
    setFailure('');
    setRetry(false);
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

  /**
   * Facts under every other key (the Eagle or DEMI id, a project that gave the code up) and the links
   * list. `keep` is the entry just written from the PUT's own answer.
   */
  const refreshShortLinks = (keep?: string) => {
    void queryClient.invalidateQueries({
      queryKey: PROJECT_FACTS_QUERY,
      predicate: (query) => query.queryKey[1] !== keep,
    });
    void queryClient.invalidateQueries({ queryKey: LINKS_QUERY });
  };

  async function save() {
    setTouched(true);
    setUrlTouched(true);
    if ((codeChanged && invalid) || (urlChanged && urlInvalid) || !canSave || saving) return;
    const change: ShortCodeChange = {};
    if (codeChanged) change.shortCode = draft;
    // A retry always sends the target: the API refuses an empty body, and an unchanged url writes nothing.
    if (urlChanged || retry) change.url = url || null;
    setSaving(true);
    setRejected('');
    setUrlRejected('');
    setFailure('');
    try {
      // The route may carry an Eagle ObjectId; the write goes to the DEMI id.
      const { url: shortLinkUrl, ...saved } = await saveShortCode(String(facts.id), change);
      await queryClient.cancelQueries({ queryKey: projectFactsKey(projectId) });
      queryClient.setQueryData<ProjectFacts>(
        projectFactsKey(projectId),
        (old) => old && { ...old, ...saved, shortLinkUrl },
      );
      refreshShortLinks(projectId);
      setRetry(false);
      close();
    } catch (err) {
      const text = err instanceof ApiError ? serverText(err) : null;
      const status = err instanceof ApiError ? err.status : 0;
      // A 503 can land after part of the write did, so what is on screen may be stale.
      if (status === 503) {
        refreshShortLinks();
        setRetry(true);
      }
      if (status === 409) setRejected(TAKEN);
      else if (status === 400 && text && !PROJECT_REFUSAL.test(text)) {
        if (change.shortCode === undefined || URL_REFUSAL.test(text)) setUrlRejected(text);
        else setRejected(text);
      } else setFailure(text ?? errorMessage(err));
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
          noValidate
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
            The old link will keep working and will go to the same place.
          </p>

          <label className="micro-label ps-short__label" htmlFor={urlId}>
            Points to
          </label>
          <div className="ps-short__field">
            <input
              ref={urlInput}
              id={urlId}
              type="url"
              inputMode="url"
              className="ps-short__input"
              autoComplete="off"
              spellCheck={false}
              placeholder="The project page"
              value={urlDraft}
              aria-invalid={urlError ? true : undefined}
              aria-describedby={`${urlErrorId} ${urlHelpId}`}
              onBlur={() => setUrlTouched(true)}
              onChange={(event) => {
                setUrlDraft(event.target.value);
                setUrlRejected('');
              }}
            />
          </div>
          <p id={urlErrorId} className="ps-short__error" aria-live="polite">
            {urlError}
          </p>
          <p id={urlHelpId} className="ps-short__help">
            Leave empty to open the project page.
          </p>
          <button
            type="button"
            className="ps-card__link ps-card__link--button ps-short__reset"
            disabled={saving}
            onClick={() => {
              setUrlDraft('');
              setUrlRejected('');
              urlInput.current?.focus();
            }}
          >
            Use the project page
          </button>

          <div className="ps-short__actions">
            <button type="submit" disabled={saving || !canSave} style={primaryButton}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={close} disabled={saving} style={secondaryButton}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <p className="ps-short__line">
          Short URL:{' '}
          <a href={shortUrl} target="_blank" rel="noopener noreferrer">
            <code className="cell__mono">{prefix === null ? shortUrl : bare}</code>
          </a>
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

      {target && !editing && (
        <p className="ps-short__help">
          Points to:{' '}
          <a href={target} target="_blank" rel="noopener noreferrer">
            {target}
          </a>
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
