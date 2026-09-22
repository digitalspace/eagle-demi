import { useState } from 'react';
import type { SavedLasso } from '../api/me';

/**
 * Naming the area that is drawn. Rendered only while open, so cancelling and reopening starts with
 * an empty box rather than the abandoned name.
 */
export function SaveAreaForm({
  open,
  onOpen,
  onCancel,
  saving,
  onSave,
}: {
  open: boolean;
  onOpen: () => void;
  onCancel: () => void;
  saving: boolean;
  onSave: (name: string) => void;
}) {
  if (!open) {
    return (
      <button type="button" className="demi-lasso-save__open" onClick={onOpen}>
        Save this area
      </button>
    );
  }
  return <NameForm onCancel={onCancel} saving={saving} onSave={onSave} />;
}

/** Its own component so closing the form unmounts it, taking the abandoned name with it. */
function NameForm({
  onCancel,
  saving,
  onSave,
}: {
  onCancel: () => void;
  saving: boolean;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState('');

  return (
    <form
      className="demi-lasso-save"
      onSubmit={(event) => {
        event.preventDefault();
        // A disabled button already blocks this, but Enter can still race a pending save.
        if (!name.trim() || saving) return;
        onSave(name.trim());
      }}
    >
      <input
        type="text"
        placeholder="Name this area"
        aria-label="Name this area"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <button type="submit" disabled={!name.trim() || saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
      <button type="button" aria-label="Cancel" onClick={onCancel}>
        ✕
      </button>
    </form>
  );
}

export function SavedAreasPanel({
  open,
  onToggle,
  areas,
  loading,
  onApply,
  onDelete,
}: {
  open: boolean;
  onToggle: () => void;
  areas: SavedLasso[];
  loading: boolean;
  onApply: (area: SavedLasso) => void;
  onDelete: (area: SavedLasso) => void;
}) {
  return (
    <div className="demi-saved-areas">
      <button type="button" className="map-control-btn" aria-expanded={open} onClick={onToggle}>
        Saved areas
      </button>

      {open && (
        <div className="demi-saved-areas__panel">
          <div className="micro-label">Saved areas</div>
          {areas.length ? (
            areas.map((area) => (
              <div key={area.slug} className="demi-saved-areas__row">
                <button type="button" onClick={() => onApply(area)}>
                  {area.name}
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${area.name}`}
                  onClick={() => onDelete(area)}
                >
                  ✕
                </button>
              </div>
            ))
          ) : (
            <p className="cell__sub">
              {loading ? 'Loading…' : 'Draw an area with the lasso, then save it.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
