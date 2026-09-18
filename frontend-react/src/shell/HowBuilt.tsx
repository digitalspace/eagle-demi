import { useEffect, useRef, type CSSProperties } from 'react';
import { TECH, TECH_CHIP } from './screens';

const backdrop: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 950,
  background: 'rgba(0,0,0,0.35)',
  display: 'grid',
  placeItems: 'center',
  padding: 'var(--layout-padding-large)',
};
const dialog: CSSProperties = {
  width: '34rem',
  maxWidth: '100%',
  maxHeight: '80vh',
  overflowY: 'auto',
  boxSizing: 'border-box',
  background: 'var(--surface-color-background-white)',
  borderRadius: 'var(--layout-border-radius-medium)',
  boxShadow: '0 8px 30px rgba(0,0,0,0.3)',
  padding: 'var(--layout-padding-large)',
};
const titleRow: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 'var(--layout-margin-small)',
};
const close: CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  font: 'var(--typography-bold-body)',
  color: 'var(--typography-color-secondary)',
};
const chips: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px',
  marginTop: 'var(--layout-margin-medium)',
};

// TECH_CHIP is one CSS declaration string, shared with every screen that lists provenance. React's
// style prop takes an object, so it is converted once here rather than written out a second time.
const chipStyle = Object.fromEntries(
  TECH_CHIP.split(';')
    .map((rule) => rule.split(':'))
    .filter(([property]) => property?.trim())
    .map(([property, ...value]) => [
      property.trim().replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value.join(':').trim(),
    ]),
) as CSSProperties;

// The backdrop below closes on click. That is a pointer shortcut, not the only way out: Escape and
// the Close button are the keyboard routes, so the backdrop stays presentational.
/* eslint-disable jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions */

export function HowBuilt({ screenKey, onClose }: { screenKey: string; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const tech = TECH[screenKey] ?? TECH['map'];

  // Focus moves into the dialog on open; the overlay has no focus trap, Escape and the backdrop close it.
  useEffect(() => {
    panel.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div style={backdrop} role="presentation" onClick={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="How this screen is built"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        style={dialog}
      >
        <div style={titleRow}>
          <h2 className="panel__title panel__title--inline" style={{ margin: 0 }}>
            How {tech.title} is built
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" style={close}>
            ✕
          </button>
        </div>
        <div style={chips}>
          {tech.chips.map((chip) => (
            <span key={chip} style={chipStyle}>
              {chip}
            </span>
          ))}
        </div>
        <p className="cell__sub" style={{ margin: 'var(--layout-margin-medium) 0 0' }}>
          {tech.note}
        </p>
      </div>
    </div>
  );
}
