import { Fragment, type RefObject } from 'react';
import { Link } from 'react-router';
import type { DocKind, MarkStyle, Tip } from './chart-types';
import { DOC_LINKS } from './overview-links';

/** What a delegated mark's `data-tip-*` attributes add to its tip: the type line, its swatch look and the popup link. */
export interface TipMore {
  type: string;
  /** The mark's classes but the delegate's own, for the swatch. */
  look: string;
  /** The mark's `--pc` phase colour. */
  pc: string;
  kind: string;
  doc: string;
}

export interface Shown {
  tip: Tip;
  more: TipMore | null;
  anchor: Element;
  x: number;
  y: number;
  below: boolean;
  /** Opened by a click or Enter: stays until Escape, a press outside, or focus leaving it. */
  pinned: boolean;
}

const DocIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 1.75h5.25L12.5 5v9.25H4z" />
    <path d="M9 1.75V5.25h3.5M6 8.25h4.5M6 10.75h4.5" strokeLinecap="round" />
  </svg>
);

/** The popup's document link: an eagle-admin search in a new tab, or the record page. */
function TipLink({ more, anchor, search }: { more: TipMore; anchor: Element; search: string }) {
  const link = DOC_LINKS[more.kind as DocKind];
  if (!link) return null;
  if (link.external) {
    return (
      <a className="wp-tip__doc" href={more.doc} target="_blank" rel="noopener noreferrer">
        <DocIcon />
        {link.text}
        <span className="visually-hidden"> (opens in a new tab)</span>
      </a>
    );
  }
  // The Overview row's own state, so the record page's way back returns to this row and these filters.
  return (
    <Link className="wp-tip__doc" to={more.doc} state={{ from: search, rowId: anchor.closest('.wp-ov-rw')?.id ?? null }}>
      <DocIcon />
      {link.text}
    </Link>
  );
}

interface TipBoxProps {
  shown: Shown | null;
  tipRef: RefObject<HTMLDivElement | null>;
  /** The page's search string, for the record link's way back. */
  search: string;
  keep: () => void;
  hideSoon: () => void;
}

/** The one `role="tooltip"` element: title, type line with swatch, label and value rows, and the popup link. */
export function TipBox({ shown, tipRef, search, keep, hideSoon }: TipBoxProps) {
  const more = shown?.more;
  const swatch: MarkStyle | undefined = more?.pc ? { '--pc': more.pc } : undefined;
  return (
    <div
      ref={tipRef}
      role="tooltip"
      className={shown?.below ? 'wp-tip wp-tip--below' : 'wp-tip'}
      hidden={!shown}
      style={shown ? { left: shown.x, top: shown.y } : undefined}
      onMouseEnter={keep}
      onMouseLeave={hideSoon}
    >
      {shown && (
        <>
          <strong className="wp-tip__title">{shown.tip.title}</strong>
          {more?.type && (
            <span className="wp-tip__type">
              <span className={`wp-tip__sw ${more.look}`} style={swatch} aria-hidden="true" />
              {more.type}
            </span>
          )}
          {shown.tip.rows.map((row, index) => (
            <Fragment key={index}>
              <span className="wp-tip__label">{row.label}</span>
              <span className="wp-tip__value">{row.value}</span>
            </Fragment>
          ))}
          {more?.doc && <TipLink more={more} anchor={shown.anchor} search={search} />}
        </>
      )}
    </div>
  );
}
