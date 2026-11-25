import { useEffect, useRef, type ReactNode } from 'react';
import './chart-controls.css';

export interface MarkKeyItem {
  label: string;
  /** Drawn by the caller with its page's own mark classes; hidden from screen readers. */
  swatch: ReactNode;
}

export interface MarkKeyGroup {
  title: string;
  /** A short line under the title. */
  note?: string;
  items: MarkKeyItem[];
}

const buttonIdOf = (id: string) => `${id}-button`;
const panelIdOf = (id: string) => `${id}-panel`;

/** The button for an `AllMarksPanel` of the same `id`: "All marks" text, or the Overview's round info button. */
export function AllMarksButton({ id, open, onToggle, floating }: { id: string; open: boolean; onToggle: () => void; floating?: boolean }) {
  return (
    <button
      type="button"
      id={buttonIdOf(id)}
      className={floating ? 'wp-allmarks__float' : 'wp-btn wp-btn--secondary wp-allmarks__button'}
      aria-label={floating ? 'Legend' : undefined}
      aria-expanded={open}
      aria-controls={panelIdOf(id)}
      onClick={onToggle}
    >
      {!floating && 'All marks'}
      {floating ? (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          {open ? (
            <path d="M7 7l10 10M17 7L7 17" />
          ) : (
            <>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 11v6" />
              <path d="M12 7.5v.01" strokeWidth="2.5" />
            </>
          )}
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 6l4 4 4-4" />
        </svg>
      )}
    </button>
  );
}

function KeyGroup({ group }: { group: MarkKeyGroup }) {
  return (
    <div className="wp-allmarks__group">
      <h3 className="wp-allmarks__title">{group.title}</h3>
      {group.note && <p className="wp-allmarks__note">{group.note}</p>}
      <ul className="wp-allmarks__list">
        {group.items.map((item) => (
          <li key={item.label} className="wp-allmarks__item">
            <span className="wp-allmarks__swatch" aria-hidden="true">
              {item.swatch}
            </span>
            <span>{item.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The key of every mark the page can draw. Escape closes it and returns focus to its button when focus was in
 * either; a `floating` panel also closes on a pointer-down outside both and scrolls on its own.
 */
export function AllMarksPanel({
  id,
  open,
  onClose,
  groups,
  columns,
  variant,
  label,
  heading,
}: {
  id: string;
  open: boolean;
  onClose: () => void;
  groups?: readonly MarkKeyGroup[];
  /** Fixed columns of groups, top to bottom; replaces `groups`, which flow on their own. */
  columns?: readonly (readonly MarkKeyGroup[])[];
  variant: 'floating' | 'inline';
  /** Names the region; without it the button's name does. */
  label?: string;
  heading?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const floating = variant === 'floating';

  useEffect(() => {
    if (!open) return;
    const button = () => document.getElementById(buttonIdOf(id));
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const focus = document.activeElement;
      const returnFocus = !focus || focus === document.body || !!button()?.contains(focus) || !!panel.current?.contains(focus);
      event.preventDefault();
      onClose();
      if (returnFocus) button()?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || button()?.contains(target) || panel.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    if (floating) document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open, id, floating, onClose]);

  return (
    <div
      ref={panel}
      id={panelIdOf(id)}
      className={`wp-allmarks__panel wp-allmarks__panel--${variant}`}
      role="region"
      aria-label={label}
      aria-labelledby={label ? undefined : buttonIdOf(id)}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the floating panel scrolls on its own, so keyboard users need a stop on it
      tabIndex={floating ? 0 : undefined}
      hidden={!open}
    >
      {heading && <h2 className="wp-allmarks__head">{heading}</h2>}
      {columns ? (
        <div className="wp-allmarks__groups wp-allmarks__groups--cols">
          {columns.map((column) => (
            <div key={column[0]?.title} className="wp-allmarks__col">
              {column.map((group) => (
                <KeyGroup key={group.title} group={group} />
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="wp-allmarks__groups">
          {groups?.map((group) => (
            <KeyGroup key={group.title} group={group} />
          ))}
        </div>
      )}
    </div>
  );
}
