import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSaveQuery } from '../../api/me';
import { errorMessage } from '../../api/client';
import './saved-query-dialog.css';

const SAVED_QUERY_NAME_MAX = 80;

/**
 * Names the current search and saves it, so the reader can come back to it from the toolbar.
 * Mounted per opening, so each one starts with an empty name and no error.
 */
export function SavedQueryDialog({ search, onClose }: { search: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState('');
  const save = useSaveQuery();
  const length = name.trim().length;
  const valid = length > 0 && length <= SAVED_QUERY_NAME_MAX;

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  const close = () => dialog.current?.close();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || save.isPending) return;
    try {
      // The save reloads /me/data on success, which is what refreshes the toolbar's list.
      await save.mutateAsync({ name: name.trim(), search });
    } catch {
      // The refusal reaches the reader through the alert below; the dialog stays open.
      return;
    }
    close();
  }

  return (
    <dialog ref={dialog} className="saved-query" aria-labelledby="saved-query-title" onClose={onClose}>
      <form className="saved-query__sheet" onSubmit={onSubmit}>
        <h2 id="saved-query-title" className="saved-query__title">
          Save this query
        </h2>

        <label className="saved-query__label" htmlFor="saved-query-name">
          Name
        </label>
        <input
          id="saved-query-name"
          className="saved-query__input"
          type="text"
          autoComplete="off"
          value={name}
          maxLength={SAVED_QUERY_NAME_MAX}
          onChange={(event) => setName(event.target.value)}
        />
        <p className="saved-query__hint">1 to {SAVED_QUERY_NAME_MAX} characters.</p>

        {save.error && (
          <p className="saved-query__error" role="alert">
            {errorMessage(save.error)}
          </p>
        )}

        <div className="saved-query__actions">
          <button type="button" className="saved-query__button" onClick={close}>
            Cancel
          </button>
          <button
            type="submit"
            className="saved-query__button saved-query__button--primary"
            disabled={!valid || save.isPending}
          >
            Save
          </button>
        </div>
      </form>
    </dialog>
  );
}
