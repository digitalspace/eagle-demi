import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router';
import {
  gridCollator,
  passageLabel,
  type AdvancedField,
  type FilterValue,
  type FilterValues,
  type GridColumn,
  type ListRowAttachment,
  type PassageHit,
  type PassageRow,
  type SortState,
  type ValueOption,
} from '../grid-types';
import { PAGE_SIZES, readFilterValue } from '../grid-url';
import { excerptAround, highlightParts } from '../highlight';
import { useDismissable } from '../../map/use-dismissable';
import { asText, isValidIsoDate, pageNumbers } from './grid-format';

type Row = Record<string, unknown>;

export const ADVANCED_FILTERS_ID = 'display-grid-advanced-filters';
export const FILTER_TEXT_MAX = 120;
const TEXT_DEBOUNCE_MS = 300;

/** Marks search hits as text nodes, so a record whose name holds markup stays text. */
export function Highlight({ text, terms = [] }: { text: string; terms?: string[] }) {
  return (
    <>
      {highlightParts(text, terms).map((part, index) =>
        part.hit ? (
          <mark key={index} className="display-grid__hit">
            {part.text}
          </mark>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

interface RecordLinkProps {
  href?: string;
  external?: boolean;
  className?: string;
  children: ReactNode;
  'data-record-name'?: boolean;
  onClick?: () => void;
}

/** An in-app route, a file that opens in a new tab, or plain text when the record has no target. */
export function RecordLink({ href, external, className, children, ...rest }: RecordLinkProps) {
  if (!href) return <>{children}</>;
  if (external) {
    return (
      <a className={className} href={href} target="_blank" rel="noopener noreferrer" {...rest}>
        {children}
      </a>
    );
  }
  return (
    <Link className={className} to={href} {...rest}>
      {children}
    </Link>
  );
}

export interface GridChip {
  id: string;
  value?: string;
  label: string;
  /** The pick as the URL holds it; two list entries can share a label. */
  raw?: string;
}

const chipKey = (chip: GridChip) => `${chip.id}:${chip.raw ?? chip.value ?? ''}`;

/**
 * The removed chip's button leaves the page with focus on it, so focus moves on to the chip that
 * took its place, or to `fallbackFocus` once no chip is left.
 */
export function ChipRow({
  chips,
  onRemove,
  onClearAll,
  fallbackFocus,
}: {
  chips: GridChip[];
  onRemove: (chip: GridChip) => void;
  onClearAll: () => void;
  fallbackFocus: RefObject<HTMLElement | null>;
}) {
  const row = useRef<HTMLDivElement>(null);
  // Compared by content: the caller builds a new array every render, press or not.
  const shown = chips.map(chipKey).join('\n');
  // Where focus goes if the next change to the chips leaves fewer than when the press happened.
  const refocus = useRef<{ index: number; count: number; shown: string } | null>(null);
  useLayoutEffect(() => {
    const pending = refocus.current;
    if (!pending || shown === pending.shown) return;
    refocus.current = null;
    if (chips.length >= pending.count) return;
    const left = row.current?.querySelectorAll<HTMLElement>('.display-grid__chip') ?? [];
    (left[Math.min(pending.index, left.length - 1)] ?? fallbackFocus.current)?.focus();
  }, [shown, chips.length, fallbackFocus]);
  if (chips.length === 0) return null;
  return (
    <div className="display-grid__chips" ref={row}>
      <span className="display-grid__chips-label">Narrowed by</span>
      {chips.map((chip, index) => (
        <button
          key={chipKey(chip)}
          type="button"
          className="display-grid__chip"
          aria-label={chip.value ? `Remove ${chip.label} ${chip.value}` : `Remove ${chip.label}`}
          onClick={() => {
            refocus.current = { index, count: chips.length, shown };
            onRemove(chip);
          }}
        >
          <span aria-hidden="true">
            {chip.value ? (
              <>
                <span className="display-grid__chip-name">{chip.label}:</span> {chip.value}
              </>
            ) : (
              chip.label
            )}
          </span>
          <span aria-hidden="true" className="display-grid__chip-x">
            ✕
          </span>
        </button>
      ))}
      <button
        type="button"
        className="display-grid__chips-clear"
        onClick={() => {
          refocus.current = { index: 0, count: chips.length, shown };
          onClearAll();
        }}
      >
        Clear all
      </button>
    </div>
  );
}

export function GridHeader({
  columns,
  sort,
  onSort,
}: {
  columns: GridColumn<Row>[];
  sort: SortState | null;
  onSort: (key: string) => void;
}) {
  return (
    <tr>
      {columns.map((column) => {
        const active = sort?.key === column.key;
        const asc = sort?.dir === 'asc';
        return (
          <th
            key={column.key}
            scope="col"
            className={`display-grid__head-cell${active ? ' display-grid__head-cell--sorted' : ''}`}
            style={column.width ? { width: column.width } : undefined}
            aria-sort={active ? (asc ? 'ascending' : 'descending') : undefined}
          >
            {column.sortable !== false ? (
              <button type="button" className="display-grid__sort" onClick={() => onSort(column.key)}>
                <span className="display-grid__sort-label">{column.label}</span>
                <span className="display-grid__sort-arrow" aria-hidden="true">
                  {active ? (asc ? '▲' : '▼') : '⇅'}
                </span>
              </button>
            ) : (
              <span className="display-grid__head-label">{column.label}</span>
            )}
          </th>
        );
      })}
    </tr>
  );
}

function asArray(value: FilterValue | undefined): string[] {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

/** Typed text held locally and sent once typing stops, so a keystroke is not a request. */
function useDebouncedText(value: string, onSettle: (value: string) => void) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  // The last text this field sent, which tells its own write apart from a chip or Clear all.
  const [sent, setSent] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const settle = useRef(onSettle);
  useEffect(() => {
    settle.current = onSettle;
  }, [onSettle]);
  if (value !== seen) {
    setSeen(value);
    if (value !== sent) setDraft(value);
  }
  // A value from outside also drops the pending send, or it would write the old text back.
  useEffect(() => {
    if (value !== sent) clearTimeout(timer.current);
  }, [value, sent]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const change = (next: string) => {
    setDraft(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      // As the URL hands it back: "Smith," returns as "Smith", which is still this field's own write.
      setSent(asText(readFilterValue(next)));
      settle.current(next);
    }, TEXT_DEBOUNCE_MS);
  };
  return [draft, change] as const;
}

function TextFilter({ column, value, onChange }: { column: GridColumn<Row>; value: string; onChange: (v: string) => void }) {
  const [draft, change] = useDebouncedText(value, onChange);
  return (
    <label>
      <span className="display-grid__visually-hidden">Filter by {column.label}</span>
      <input
        type="text"
        autoComplete="off"
        maxLength={FILTER_TEXT_MAX}
        className={`display-grid__control${value ? ' display-grid__control--on' : ''}`}
        placeholder={column.label}
        value={draft}
        onChange={(event) => change(event.target.value)}
      />
    </label>
  );
}

function YearPicker({ label, years, value, onChange }: { label: string; years: string[]; value: string; onChange: (v: string) => void }) {
  const newestFirst = [...new Set(years)].sort((a, b) => gridCollator.compare(b, a));
  return (
    <label>
      <span className="display-grid__visually-hidden">Filter by {label}</span>
      <select
        className={`display-grid__control${value ? ' display-grid__control--on' : ''}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Any date</option>
        {newestFirst.map((year) => (
          <option key={year} value={year}>
            {year}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Past this many options the picker gains a type-to-narrow box. */
const TYPEAHEAD_FROM = 40;

function ValuePicker({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: ValueOption[];
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const anchor = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // The narrowing belongs to one opening; the next one starts with every option.
  const close = useCallback(() => {
    setOpen(false);
    setTyped('');
  }, []);
  useDismissable(open, anchor, button, close);
  const picked = options.filter((option) => selected.includes(option.value));
  const term = typed.trim().toLowerCase();
  const shown = term ? options.filter((option) => option.label.toLowerCase().includes(term)) : options;
  const buttonText = picked.length === 0 ? 'All' : picked.length === 1 ? picked[0].label : `${picked.length} selected`;
  const toggle = (value: string) =>
    onChange(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  // The span stands where Angular's inline host element stood, so the picker CSS lays out the same.
  return (
    <span ref={anchor}>
      <button
        ref={button}
        type="button"
        className={`display-grid__control display-grid__pick${picked.length > 0 ? ' display-grid__control--on' : ''}`}
        aria-label={`Filter by ${label}`}
        aria-expanded={open}
        title={picked.length ? picked.map((option) => option.label).join(', ') : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="display-grid__pick-label">{buttonText}</span>
        <span className="display-grid__pick-caret" aria-hidden="true">
          ▼
        </span>
      </button>
      {open && (
        <div className="display-grid__picker" role="group" aria-label={`Filter by ${label}`}>
          <div className="display-grid__picker-head">
            <p className="display-grid__picker-title">Filter by {label}</p>
            {picked.length > 0 && (
              <button type="button" className="display-grid__picker-clear" aria-label={`Clear ${label}`} onClick={() => onChange([])}>
                Clear
              </button>
            )}
          </div>
          {options.length > TYPEAHEAD_FROM && (
            <input
              type="text"
              className="display-grid__control"
              autoComplete="off"
              placeholder={`Search ${label.toLowerCase()}`}
              aria-label={`Search ${label.toLowerCase()}`}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          )}
          {shown.map((option) => (
            <label key={option.value} className="display-grid__option">
              <input type="checkbox" checked={selected.includes(option.value)} onChange={() => toggle(option.value)} />
              {option.label}
            </label>
          ))}
        </div>
      )}
    </span>
  );
}

export function FilterRow({
  columns,
  values,
  onChange,
}: {
  columns: GridColumn<Row>[];
  values: FilterValues;
  onChange: (id: string, value: FilterValue) => void;
}) {
  return (
    <tr className="display-grid__filter-row" data-tour="filterrow">
      {columns.map((column) => {
        const id = column.filterId ?? column.key;
        return (
          <td key={column.key} className="display-grid__filter-cell">
            {column.filter === 'text' && (
              <TextFilter column={column} value={asText(values[id])} onChange={(value) => onChange(id, value)} />
            )}
            {column.filter === 'year' && (
              <YearPicker
                label={column.label}
                years={(column.options ?? []).map((option) => option.value)}
                value={asText(values[id])}
                onChange={(value) => onChange(id, value)}
              />
            )}
            {column.filter === 'values' && (
              <ValuePicker
                label={column.label}
                options={column.options ?? []}
                selected={asArray(values[id])}
                onChange={(value) => onChange(id, value)}
              />
            )}
          </td>
        );
      })}
    </tr>
  );
}

export function GridFooter({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(page, 1), totalPages);
  const change = (next: number) => {
    if (next === current || next < 1 || next > totalPages) return;
    onPageChange(next);
  };
  return (
    <>
      <div className="display-grid__footer-group" role="group" aria-label="Rows per page">
        <span className="display-grid__footer-label">Per page</span>
        {PAGE_SIZES.map((size) => (
          <button
            key={size}
            type="button"
            className={`display-grid__page-chip${size === pageSize ? ' display-grid__page-chip--current' : ''}`}
            aria-pressed={size === pageSize}
            title={`Show ${size} records per page`}
            onClick={() => onPageSizeChange(size)}
          >
            {size}
          </button>
        ))}
      </div>
      <nav aria-label="Result pages">
        <ul className="display-grid__pager">
          <li>
            <button type="button" className="display-grid__page-chip" disabled={current === 1} aria-label="Previous page" onClick={() => change(current - 1)}>
              <span aria-hidden="true">&#8249;</span>
            </button>
          </li>
          {pageNumbers(totalPages, current).map((entry, index) => (
            <li key={index}>
              {entry === 'ellipsis' ? (
                <span className="display-grid__page-gap" aria-hidden="true">
                  …
                </span>
              ) : (
                <button
                  type="button"
                  className={`display-grid__page-chip${entry === current ? ' display-grid__page-chip--current' : ''}`}
                  aria-label={`Go to page ${entry}`}
                  aria-current={entry === current ? 'page' : undefined}
                  onClick={() => change(entry)}
                >
                  {entry}
                </button>
              )}
            </li>
          ))}
          <li>
            <button type="button" className="display-grid__page-chip" disabled={current >= totalPages} aria-label="Next page" onClick={() => change(current + 1)}>
              <span aria-hidden="true">&#8250;</span>
            </button>
          </li>
        </ul>
      </nav>
    </>
  );
}

const DATE_FORMAT = 'YYYY-MM-DD';

function DateField({ field, value, onChange }: { field: AdvancedField; value: string; onChange: (v: string | null) => void }) {
  // The field holds what was typed; the filter holds only what parsed, or the input erases itself.
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  // A value from outside (a chip, Clear all) replaces what was typed.
  if (value !== seen) {
    setSeen(value);
    setDraft(value);
  }
  const typed = draft.trim();
  const invalid = typed !== '' && !isValidIsoDate(typed);
  const errorId = `${ADVANCED_FILTERS_ID}-${field.id}-error`;
  return (
    <label className="display-grid__panel-field">
      <span className="display-grid__panel-label">
        {field.label} <span className="display-grid__panel-format">{DATE_FORMAT}</span>
      </span>
      <input
        type="text"
        inputMode="numeric"
        className="display-grid__panel-control"
        placeholder={DATE_FORMAT}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
        value={draft}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          if (next.trim() === '') onChange(null);
          else if (isValidIsoDate(next.trim())) onChange(next.trim());
        }}
      />
      {invalid && (
        <span id={errorId} role="alert" className="display-grid__panel-error">
          Use {DATE_FORMAT}, for example 2025-06-01
        </span>
      )}
    </label>
  );
}

function PanelText({ field, value, onChange }: { field: AdvancedField; value: string; onChange: (v: string | null) => void }) {
  const [draft, change] = useDebouncedText(value, (next) => onChange(next || null));
  return (
    <label className="display-grid__panel-field">
      <span className="display-grid__panel-label">{field.label}</span>
      <input
        type="text"
        autoComplete="off"
        maxLength={FILTER_TEXT_MAX}
        className="display-grid__panel-control"
        placeholder={field.placeholder}
        value={draft}
        onChange={(event) => change(event.target.value)}
      />
    </label>
  );
}

export function AdvancedFilters({
  fields,
  values,
  open,
  onChange,
}: {
  fields: AdvancedField[];
  values: FilterValues;
  open: boolean;
  onChange: (id: string, value: string | null) => void;
}) {
  return (
    <div className="display-grid__panel" id={ADVANCED_FILTERS_ID} hidden={!open} aria-label="Advanced filters">
      <h2 className="display-grid__panel-heading">Advanced filters</h2>
      <div className="display-grid__panel-grid">
        {fields.map((field) => {
          const value = asText(values[field.id]);
          const set = (next: string | null) => onChange(field.id, next);
          if (field.kind === 'toggle') {
            return (
              <label key={field.id} className="display-grid__panel-field">
                <span className="display-grid__panel-label">{field.label}</span>
                <span className="display-grid__panel-toggle">
                  <input type="checkbox" checked={value === 'true'} onChange={(event) => set(event.target.checked ? 'true' : null)} />
                </span>
              </label>
            );
          }
          if (field.kind === 'date') return <DateField key={field.id} field={field} value={value} onChange={set} />;
          if (field.kind === 'select') {
            return (
              <label key={field.id} className="display-grid__panel-field">
                <span className="display-grid__panel-label">{field.label}</span>
                <select className="display-grid__panel-control" value={value} onChange={(event) => set(event.target.value || null)}>
                  <option value="">All</option>
                  {(field.options ?? []).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            );
          }
          return <PanelText key={field.id} field={field} value={value} onChange={set} />;
        })}
      </div>
    </div>
  );
}

export interface ListRowField {
  label: string;
  value: string;
}

export interface ListRowMeta {
  text: string;
  href?: string;
}

export interface ListRowData {
  meta: ListRowMeta[];
  title: string;
  href?: string;
  external?: boolean;
  body?: string;
  fields?: ListRowField[];
  attachments?: ListRowAttachment[];
}

/** A body longer than this is clamped to an excerpt around the first hit. */
const CLAMP_AT = 260;

export function ListRow({ meta, title, href, external, body = '', fields = [], attachments = [], terms = [] }: ListRowData & { terms?: string[] }) {
  // Tied to the body it opened, so a new row in the same slot starts clamped.
  const [expandedBody, setExpandedBody] = useState<string | null>(null);
  const expanded = expandedBody === body;
  const setExpanded = (open: boolean) => setExpandedBody(open ? body : null);
  const long = body.length > CLAMP_AT;
  const shownBody = expanded || !long ? body : excerptAround(body, terms, { length: CLAMP_AT });
  const pairs = body ? [] : fields;
  const docsLabel = attachments.length === 1 ? '1 document' : `${attachments.length} documents`;
  return (
    <div className="display-grid__row">
      <p className="display-grid__row-meta">
        {meta.map((part, index) => (
          <span key={index}>
            {index > 0 && <span aria-hidden="true"> · </span>}
            <RecordLink href={part.href}>{part.text}</RecordLink>
          </span>
        ))}
      </p>
      <h3 className="display-grid__row-title">
        {href ? (
          <RecordLink data-record-name href={href} external={external} className="display-grid__row-link">
            <Highlight text={title} terms={terms} />
          </RecordLink>
        ) : (
          // No page to go to: the row's press opens the detail sheet, and this gives the keyboard a way in.
          <button data-record-name type="button" className="display-grid__row-name">
            <Highlight text={title} terms={terms} />
          </button>
        )}
      </h3>
      {pairs.length > 0 && (
        <dl className="display-grid__row-fields">
          {pairs.map((field) => (
            <div key={field.label}>
              <dt>{field.label}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {body && (
        <p className="display-grid__row-body">
          <Highlight text={shownBody} terms={terms} />
        </p>
      )}
      {long && (
        <button type="button" className="display-grid__row-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
      {attachments.length > 0 && (
        <div className="display-grid__row-docs">
          <p className="display-grid__row-docs-count">{docsLabel}</p>
          <ul aria-label={docsLabel}>
            {attachments.map((attachment) => {
              const detail = [attachment.type, attachment.size].filter(Boolean).join(' · ');
              return (
                <li key={attachment.href}>
                  <a href={attachment.href} download>
                    {attachment.name}
                  </a>
                  {detail && <span className="display-grid__row-docs-meta">{detail}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

const COLLAPSED_PASSAGES = 2;
const MARK_TAG = /<\/?mark>/g;
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

export function PassageList({
  rows,
  terms,
  loading,
  onDownload,
}: {
  rows: PassageRow[];
  terms: string[];
  loading: boolean;
  onDownload: (documentId: string) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [seenRows, setSeenRows] = useState(rows);
  // A new answer starts every passage list folded again.
  if (rows !== seenRows) {
    setSeenRows(rows);
    setOpen(new Set());
  }
  const toggle = (id: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <div className={loading ? 'display-grid__body--loading' : undefined} aria-busy={loading || undefined}>
      <ol className="display-grid__list">
        {rows.map((row) => {
          const isOpen = open.has(row.id);
          const shown: PassageHit[] = isOpen ? row.passages : row.passages.slice(0, COLLAPSED_PASSAGES);
          const rest = row.passages.length - COLLAPSED_PASSAGES;
          const count = plural(row.total, 'matching passage');
          return (
            <li key={row.id} className="display-grid__list-item">
              <div className="display-grid__row">
                <p className="display-grid__row-meta">
                  {[row.date, row.type, row.author]
                    .filter((part): part is string => !!part)
                    .map((part, index) => (
                      <span key={index}>
                        {index > 0 && <span aria-hidden="true"> · </span>}
                        {part}
                      </span>
                    ))}
                </p>
                <h3 className="display-grid__row-title">
                  <button type="button" className="display-grid__row-link" onClick={() => onDownload(row.id)}>
                    <Highlight text={row.name} terms={terms} />
                  </button>
                </h3>
                <p className="display-grid__passage-count">{count}</p>
                <ul className="display-grid__passages" aria-label={count}>
                  {shown.map((hit, index) => (
                    <li key={index} className="display-grid__passage">
                      <span className="display-grid__passage-locator">{passageLabel(hit)}</span>
                      <span className="display-grid__passage-text">
                        <Highlight text={hit.text.replace(MARK_TAG, '')} terms={terms} />
                      </span>
                    </li>
                  ))}
                </ul>
                {rest > 0 && (
                  <button type="button" className="display-grid__row-more" aria-expanded={isOpen} onClick={() => toggle(row.id)}>
                    {isOpen ? 'Show fewer passages' : plural(rest, 'more passage')}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
