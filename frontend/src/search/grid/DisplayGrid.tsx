import { useCallback, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { errorMessage } from '../../api/client';
import { useDeleteQuery, useMyData } from '../../api/me';
import { useDismissable } from '../../map/use-dismissable';
import { useNarrow } from '../../shell/useNarrow';
import {
  columnFiltersForPanel,
  sortValueOf,
  type AdvancedField,
  type FilterValue,
  type FilterValues,
  type GridCell,
  type GridColumn,
  type GridTemplate,
  type SortOption,
  type SortState,
} from '../grid-types';
import { toTerms } from '../highlight';
import { savedQueryRecordLabel, savedQueryUrl } from '../saved-query';
import { countText } from './grid-format';
import {
  ADVANCED_FILTERS_ID,
  FilterRow,
  GridFooter,
  GridHeader,
  Highlight,
  ListRow,
  RecordLink,
  type ListRowData,
  type ListRowField,
  type ListRowMeta,
} from './parts';
import { RecordDetailSheet, type RecordDetail } from './RecordDetail';
import { SavedQueryDialog } from './SavedQueryDialog';
import './display-grid.css';
import './chip-row.css';
import './advanced-filters.css';
import './list-row.css';
import './passage-list.css';
import './highlight.css';
import './display-grid.reset.css';

type Row = Record<string, unknown>;

/** A press on one of these inside a row is its own action and does not open the record. */
const INTERACTIVE = 'a[href], button, input, select, textarea, label, [role="button"]';

/** The record's name: a press on it opens the sheet, while its `href` keeps middle-click and copy. */
const NAME_TARGET = '[data-record-name]';

/** Row values no column draws that the sheet still shows. */
const DETAIL_EXTRA_FIELDS: { key: string; label: string }[] = [{ key: 'status', label: 'Status' }];

/** The row value read as the sheet's prose. */
const DETAIL_BODY_KEY = 'description';

/** Below this the table gives way to one card per record. */
export const NARROW_QUERY = '(max-width: 719.98px)';

const SKELETON_ROWS = Array.from({ length: 5 }, (_, index) => index);

/** The sort select offered where no column heading can be clicked: lists and narrow cards. */
function sortOptionsFor(columns: GridColumn<Row>[], sort: SortState | null): SortOption[] {
  const date = columns.find((column) => column.primaryDate) ?? columns.find((column) => column.date);
  const name = columns.find((column) => column.link) ?? columns.find((column) => column.sortable);
  const options: SortOption[] = [];
  if (date?.sortable) {
    options.push({ value: `-${date.key}`, label: 'Newest first' }, { value: `+${date.key}`, label: 'Oldest first' });
  }
  if (name?.sortable) {
    options.push({ value: `+${name.key}`, label: 'Name A–Z' }, { value: `-${name.key}`, label: 'Name Z–A' });
  }
  if (sort && !options.some((option) => option.value === sortValueOf(sort))) {
    const column = columns.find((item) => item.key === sort.key);
    if (column) options.push({ value: sortValueOf(sort), label: column.label });
  }
  return options;
}

function readCell(row: Row, key: string): string {
  const value = row[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function textOf(row: Row, column: GridColumn<Row>): string {
  return column.render ? column.render(row) : readCell(row, column.key);
}

function cellOf(row: Row, column: GridColumn<Row>): GridCell {
  if (column.cell) return column.cell(row);
  const text = textOf(row, column);
  if (!column.link) return { kind: 'text', text };
  const href = column.href?.(row);
  return href ? { kind: 'link', text, href, external: column.hrefExternal } : { kind: 'text', text };
}

function rowKey(row: Row, index: number): string {
  const id = row['_id'] ?? row['documentId'];
  return typeof id === 'string' && id !== '' ? id : String(index);
}

function anyFilterSet(filters: FilterValues): boolean {
  return Object.values(filters).some((value) => (Array.isArray(value) ? value.length > 0 : value.trim() !== ''));
}

export interface DisplayGridProps {
  caption: string;
  columns: GridColumn<Row>[];
  rows: Row[];
  loading: boolean;
  keywords: string;
  emptyMessage: string;
  sort: SortState | null;
  filters: FilterValues;
  page: number;
  pageSize: number;
  total: number;
  narrowExtras: (row: Row) => ListRowField[];
  template: GridTemplate;
  headerless: boolean;
  listRow: (row: Row) => ListRowData;
  sortOptions?: SortOption[];
  /** The page draws the records itself (passages); the grid keeps its frame. */
  body?: ReactNode;
  footer: boolean;
  /** The record's own panel fields. The grid adds the column filters no filter row is holding. */
  advancedFields: AdvancedField[];
  toolbar: (panelFields: AdvancedField[]) => ReactNode;
  chips: ReactNode;
  panel: (panelFields: AdvancedField[]) => ReactNode;
  onSort: (key: string) => void;
  onSortPicked: (key: string, dir: '+' | '-') => void;
  onFilterChange: (id: string, value: FilterValue) => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  onDownload: (documentId: string) => void;
  /** A change remounts the filter row, dropping every draft and pending send. */
  resetKey?: string;
}

export function DisplayGrid(props: DisplayGridProps) {
  const { columns, rows, loading, filters, sort, template, body } = props;
  const narrow = useNarrow(NARROW_QUERY);
  const terms = toTerms(props.keywords);

  const listMode = template === 'list';
  const customBody = body !== undefined;
  const showSkeleton = loading && rows.length === 0;
  const showEmpty = !customBody && !loading && rows.length === 0;
  const cardMode = narrow && !listMode && !showEmpty;
  const showHead = !listMode && !props.headerless && !cardMode && (!showEmpty || anyFilterSet(filters));
  const showFilterRow = showHead && columns.some((column) => !!column.filter);
  const sortChoices = props.sortOptions ?? sortOptionsFor(columns, sort);
  const showSortBar = !showEmpty && (listMode || cardMode) && sortChoices.length > 0;
  const sortValue = sort ? sortValueOf(sort) : '';
  // A list, a headerless type, a narrow card or an empty result draws no filter row.
  const panelFields = showFilterRow
    ? props.advancedFields
    : [...props.advancedFields, ...columnFiltersForPanel(columns)];

  const headline = columns.find((column) => column.link) ?? columns[0] ?? null;
  const dateColumn = columns.find((column) => column.primaryDate) ?? columns.find((column) => column.date) ?? null;

  const cardMeta = (row: Row): ListRowMeta[] => {
    const text = dateColumn ? textOf(row, dateColumn) : '';
    return text ? [{ text }] : [];
  };
  const cardFields = (row: Row): ListRowField[] =>
    [
      ...columns
        .filter((column) => !column.link && !column.date)
        .map((column) => ({ label: column.label, value: textOf(row, column) })),
      ...props.narrowExtras(row),
    ].filter((field) => field.value !== '');

  const [detail, setDetail] = useState<RecordDetail | null>(null);
  // What was pressed to open the sheet, so focus goes back to it rather than to the top.
  const opener = useRef<HTMLElement | null>(null);

  /** One record as the sheet reads it, from the same column config the grid draws with. */
  function detailOf(row: Row): RecordDetail {
    if (listMode) {
      const data = props.listRow(row);
      return {
        title: data.title,
        meta: data.meta,
        fields: data.fields ?? [],
        body: data.body,
        attachments: data.attachments,
        link: data.href ? { href: data.href, label: 'Open record', external: data.external } : undefined,
      };
    }
    const extras = DETAIL_EXTRA_FIELDS.map((extra) => ({ label: extra.label, value: readCell(row, extra.key) }));
    const fields = [
      ...(dateColumn ? [{ label: dateColumn.label, value: textOf(row, dateColumn) }] : []),
      ...cardFields(row),
      ...extras,
    ].filter((field) => field.value !== '');
    const cell = headline ? cellOf(row, headline) : null;
    const record: RecordDetail = {
      title: headline ? textOf(row, headline) : '',
      meta: [],
      fields,
      body: readCell(row, DETAIL_BODY_KEY) || undefined,
    };
    if (cell?.kind === 'link' && headline) {
      record.link = { href: cell.href, label: `Open ${headline.label.toLowerCase()} page`, external: cell.external };
    }
    if (cell?.kind === 'download') record.documentId = cell.documentId;
    return record;
  }

  /**
   * A press on a row opens the record rather than leaving the result set. The name keeps its
   * `href` so middle-click and copy still work, which is why only an unmodified left press is
   * turned back here.
   */
  function openDetail(row: Row, event: MouseEvent<HTMLElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }
    const pressed = (event.target as Element | null)?.closest<HTMLElement>(INTERACTIVE) ?? null;
    if (pressed && !pressed.closest(NAME_TARGET)) return;
    if (pressed) event.preventDefault();
    opener.current = pressed ?? event.currentTarget;
    setDetail(detailOf(row));
  }

  function closeDetail() {
    setDetail(null);
    opener.current?.focus();
    opener.current = null;
  }

  function cellContent(cell: GridCell): ReactNode {
    switch (cell.kind) {
      case 'link':
        return (
          <RecordLink data-record-name href={cell.href} external={!!cell.external} className="display-grid__cell-link">
            <Highlight text={cell.text} />
          </RecordLink>
        );
      case 'download':
        return (
          <button data-record-name type="button" className="display-grid__cell-link">
            <Highlight text={cell.text} />
          </button>
        );
      case 'badge':
        return <span className="display-grid__badge">{cell.text}</span>;
      default:
        return <Highlight text={cell.text} />;
    }
  }

  let records: ReactNode;
  if (customBody) {
    records = body;
  } else if (listMode) {
    records = (
      <>
        <p className="display-grid__visually-hidden">{props.caption}</p>
        <ul className="display-grid__list">
          {rows.map((row, index) => (
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- the name control inside is the keyboard path
            <li key={rowKey(row, index)} className="display-grid__list-item display-grid__row--pressable" tabIndex={-1} onClick={(event) => openDetail(row, event)}>
              <ListRow {...props.listRow(row)} terms={terms} />
            </li>
          ))}
        </ul>
      </>
    );
  } else if (cardMode) {
    records = (
      <>
        <p className="display-grid__visually-hidden">{props.caption}</p>
        <ol className="display-grid__cards">
          {rows.map((row, index) => {
            const cell = headline ? cellOf(row, headline) : null;
            return (
              // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- the name control inside is the keyboard path
              <li key={rowKey(row, index)} className="display-grid__card display-grid__row--pressable" tabIndex={-1} onClick={(event) => openDetail(row, event)}>
                <ListRow
                  meta={cardMeta(row)}
                  title={headline ? textOf(row, headline) : ''}
                  fields={cardFields(row)}
                  href={cell?.kind === 'link' ? cell.href : undefined}
                  external={cell?.kind === 'link' ? !!cell.external : false}
                />
              </li>
            );
          })}
        </ol>
      </>
    );
  } else {
    records = (
      <div className="display-grid__scroll">
        <table className="display-grid__table">
          <caption className="display-grid__visually-hidden">{props.caption}</caption>
          {showHead && (
            <thead>
              <GridHeader columns={columns} sort={sort} onSort={props.onSort} />
              {showFilterRow && (
                <FilterRow key={props.resetKey} columns={columns} values={filters} onChange={props.onFilterChange} />
              )}
            </thead>
          )}
          <tbody>
            {showSkeleton &&
              SKELETON_ROWS.map((skeleton) => (
                <tr key={skeleton} aria-hidden="true">
                  {columns.map((column) => (
                    <td key={column.key} className="display-grid__cell">
                      <span className="display-grid__skeleton-bar" />
                    </td>
                  ))}
                </tr>
              ))}
            {rows.map((row, index) => (
              <tr key={rowKey(row, index)} className="display-grid__row display-grid__row--pressable" tabIndex={-1} onClick={(event) => openDetail(row, event)}>
                {columns.map((column) => {
                  const cell = cellOf(row, column);
                  const badge = column.badge?.(row);
                  return (
                    <td key={column.key} className={`display-grid__cell${column.date ? ' display-grid__cell--date' : ''}`}>
                      {/* One line per cell, so a row is a row; the full value is the tooltip. */}
                      <span className="display-grid__cell-text" title={cell.kind === 'badge' ? undefined : cell.text}>
                        {badge && <span className="display-grid__badge">{badge.text}</span>}
                        {cellContent(cell)}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="display-grid">
      {props.toolbar(panelFields)}
      {/* Its own region: role="status" over the rows would re-read every control on each change. */}
      <span className="display-grid__visually-hidden" role="status">
        {showSkeleton ? 'Loading' : ''}
      </span>
      {props.chips}
      {props.panel(panelFields)}

      <div className={loading && rows.length > 0 ? 'display-grid__body--loading' : undefined} aria-busy={loading || undefined}>
        {showSortBar && (
          <div className="display-grid__sort-bar">
            <label className="display-grid__sort-bar-label">
              Sort
              <select
                className="display-grid__sort-select"
                value={sortValue}
                onChange={(event) => {
                  const next = event.target.value;
                  props.onSortPicked(next.slice(1), next.startsWith('-') ? '-' : '+');
                }}
              >
                {sortChoices.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {records}

        {showEmpty && props.emptyMessage && <p className="display-grid__empty">{props.emptyMessage}</p>}

        {props.footer && (
          <div className="display-grid__footer">
            <GridFooter
              page={props.page}
              pageSize={props.pageSize}
              total={props.total}
              onPageChange={props.onPageChange}
              onPageSizeChange={props.onPageSizeChange}
            />
          </div>
        )}
      </div>

      <RecordDetailSheet detail={detail} onClose={closeDetail} onDownload={props.onDownload} />
    </div>
  );
}

export interface GridToolbarProps {
  noun: string;
  page: number;
  pageSize: number;
  total: number;
  loading: boolean;
  narrowed: boolean;
  columns: GridColumn<Row>[];
  hiddenColumns: string[];
  filterCount: number;
  panelOpen: boolean;
  onToggleColumn: (key: string) => void;
  onTogglePanel: () => void;
  /** The scope switch, which sits right after the count it changes. */
  children?: ReactNode;
}

export function GridToolbar(props: GridToolbarProps) {
  const [columnsOpen, setColumnsOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setColumnsOpen(false), []);
  useDismissable(columnsOpen, menu, toggle, close);

  const [queriesOpen, setQueriesOpen] = useState(false);
  const queriesMenu = useRef<HTMLDivElement>(null);
  const queriesToggle = useRef<HTMLButtonElement>(null);
  const closeQueries = useCallback(() => setQueriesOpen(false), []);
  useDismissable(queriesOpen, queriesMenu, queriesToggle, closeQueries);
  const queries = useMyData().data?.queries ?? [];
  const deleteQuery = useDeleteQuery();
  const navigate = useNavigate();
  // The address bar as it stands, which is what a saved query replays.
  const { search } = useLocation();

  const [saveOpen, setSaveOpen] = useState(false);
  const saveButton = useRef<HTMLButtonElement>(null);
  const closeSave = useCallback(() => {
    setSaveOpen(false);
    saveButton.current?.focus();
  }, []);
  return (
    <div className="display-grid__bar">
      <div className="display-grid__bar-group">
        {/* The one live region: the count is what every control in this bar changes. */}
        <p className="display-grid__count" role="status">
          {countText(props)}
        </p>
        {props.children}
      </div>

      <div className="display-grid__bar-group display-grid__bar-group--tools">
        <button
          type="button"
          className={`display-grid__tool${props.filterCount > 0 ? ' display-grid__tool--on' : ''}${props.panelOpen ? ' display-grid__tool--open' : ''}`}
          data-tour="more"
          aria-expanded={props.panelOpen}
          aria-controls={ADVANCED_FILTERS_ID}
          onClick={props.onTogglePanel}
        >
          More filters
          {props.filterCount > 0 && <span className="display-grid__badge">{props.filterCount}</span>}
        </button>

        {props.columns.length > 0 && (
          <div className="display-grid__menu-anchor" ref={menu}>
            <button
              ref={toggle}
              type="button"
              className={`display-grid__tool${columnsOpen ? ' display-grid__tool--open' : ''}`}
              data-tour="columns"
              aria-expanded={columnsOpen}
              onClick={() => setColumnsOpen((open) => !open)}
            >
              Columns
            </button>
            {columnsOpen && (
              <div className="display-grid__menu" role="group" aria-label="Columns shown">
                <p className="display-grid__menu-title">Columns shown</p>
                {props.columns.map((column) => (
                  <label key={column.key} className="display-grid__option">
                    {/* The link column cannot be hidden: without it a row has nothing to open. */}
                    <input
                      type="checkbox"
                      checked={!!column.locked || !props.hiddenColumns.includes(column.key)}
                      disabled={!!column.locked}
                      onChange={() => props.onToggleColumn(column.key)}
                    />
                    {column.label}
                    {column.locked && <span className="display-grid__visually-hidden"> (required)</span>}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        <button ref={saveButton} type="button" className="display-grid__tool" onClick={() => setSaveOpen(true)}>
          Save this query
        </button>

        <div className="display-grid__menu-anchor" ref={queriesMenu}>
          <button
            ref={queriesToggle}
            type="button"
            className={`display-grid__tool${queriesOpen ? ' display-grid__tool--open' : ''}`}
            aria-expanded={queriesOpen}
            onClick={() => setQueriesOpen((open) => !open)}
          >
            Saved queries
          </button>
          {queriesOpen && (
            <div className="display-grid__menu" role="group" aria-label="Saved queries">
              <p className="display-grid__menu-title">Saved queries</p>
              {queries.length === 0 && <p className="saved-query__empty">No saved queries yet</p>}
              {deleteQuery.error && (
                <p className="saved-query__error" role="alert">
                  {errorMessage(deleteQuery.error)}
                </p>
              )}
              {queries.map((query) => (
                <div key={query.slug} className="saved-query__row">
                  <button
                    type="button"
                    className="saved-query__open"
                    onClick={() => {
                      setQueriesOpen(false);
                      navigate(savedQueryUrl(query));
                    }}
                  >
                    <span className="saved-query__name">{query.name}</span>
                    <span className="saved-query__record">{savedQueryRecordLabel(query)}</span>
                  </button>
                  <button
                    type="button"
                    className="saved-query__delete"
                    aria-label={`Delete ${query.name}`}
                    onClick={() => deleteQuery.mutate(query.slug)}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {saveOpen && <SavedQueryDialog search={search} onClose={closeSave} />}
    </div>
  );
}
