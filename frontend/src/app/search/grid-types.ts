/**
 * The grid's data model: columns, filters, sorting and passages. Types and pure helpers only, so
 * the URL layer, the record-type configs and the service can all read it without a component.
 */

export type GridTemplate = 'grid' | 'list';

export type ColumnFilter = 'text' | 'year' | 'values' | null;

export interface ValueOption {
  value: string;
  label: string;
}

/**
 * One cell's content, as a template switches on it.
 *
 * The React original returned a node here, which an Angular template cannot consume. A tagged
 * union carries the same four cases the page draws and keeps the configs free of markup.
 */
export type GridCell =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; href: string; external?: boolean }
  | { kind: 'badge'; text: string; tone: 'featured' | 'neutral' }
  | { kind: 'download'; text: string; documentId: string };

/** Which row template a list-mode record type draws itself with. */
export type RowTemplate = 'activity' | 'notification';

/** A file hanging off one record, listed under its row. */
export interface ListRowAttachment {
  name: string;
  href: string;
  /** File type as the record states it, e.g. `PDF`. */
  type?: string;
  /** Already formatted, e.g. `1.2 MB`. */
  size?: string;
}

export interface GridColumn<Row = unknown> {
  key: string;
  label: string;
  width?: string;
  sortable?: boolean;
  filter?: ColumnFilter;
  filterId?: string;
  link?: boolean;
  /** Where one record's link column points. No target leaves the name as plain text. */
  href?: (row: Row) => string | undefined;
  /** The target leaves the app — a file download, say — so it opens as a plain anchor. */
  hrefExternal?: boolean;
  /** Drawn in the cell before the link, for a marker the record carries: a featured star. */
  badge?: (row: Row) => GridCell | undefined;
  locked?: boolean;
  date?: boolean;
  primaryDate?: boolean;
  /** The cell's text where the raw field is not what the reader should see. */
  render?: (row: Row) => string;
  /** The cell as structured content, for the columns a plain string cannot describe. */
  cell?: (row: Row) => GridCell;
  options?: ValueOption[];
}

export type AdvancedFieldKind = 'date' | 'select' | 'toggle' | 'text';

export interface AdvancedField {
  id: string;
  label: string;
  kind: AdvancedFieldKind;
  options?: ValueOption[];
  placeholder?: string;
}

export type FilterValue = string | string[];
export type FilterValues = Record<string, FilterValue>;

export interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

/** One entry of the sort select, which the layouts without column headings offer instead. */
export interface SortOption {
  /** Signed field name, as the URL spells a sort: `-datePosted`. */
  value: string;
  label: string;
}

/** `-datePosted` as the sort select's value. */
export function sortValueOf(sort: SortState): string {
  return `${sort.dir === 'desc' ? '-' : '+'}${sort.key}`;
}

/** `-datePosted` as the header reads it. */
export function sortStateOf(sortBy: string): SortState | null {
  if (!sortBy) return null;
  return { key: sortBy.replace(/^[+-]/, ''), dir: sortBy.startsWith('-') ? 'desc' : 'asc' };
}

/** Natural order, so "Volume 2 of 9" precedes "Volume 10 of 9". Client-side comparisons only. */
export const gridCollator = new Intl.Collator(undefined, { numeric: true });

/**
 * The column filters as advanced-panel fields. In list and headerless modes no column is on
 * screen, so the panel is the only place their filters can live.
 */
export function columnFiltersForPanel<Row>(columns: GridColumn<Row>[]): AdvancedField[] {
  const fields: AdvancedField[] = [];
  for (const column of columns) {
    const id = column.filterId ?? column.key;
    if (column.filter === 'text') {
      fields.push({ id, label: column.label, kind: 'text', placeholder: column.label });
      // A date column is not absorbed: the panel already carries that record's date range.
    } else if (column.filter === 'values') {
      fields.push({ id, label: column.label, kind: 'select', options: column.options ?? [] });
    }
  }
  return fields;
}

export interface PassageHit {
  /** The page it sits on where the index records one, otherwise its place in the document. */
  locator: number;
  text: string;
  /** The locator is a real page number, so it reads "Page N" and links into the file. */
  pageNumbered?: boolean;
}

export interface PassageRow {
  id: string;
  name: string;
  /** The file itself. Already scheme-checked by the caller. */
  href: string;
  date: string | null;
  type: string | null;
  author: string | null;
  passages: PassageHit[];
  /** Matching passages in the document, which can be more than the search returned. */
  total: number;
}

/**
 * Where a passage sits in its file, in one place. The index does not record page numbers on every
 * document yet, so a hit is only the Nth passage the search returned and the locator is a label.
 * Once a row carries `pageNumbered` the label names the page and links into the file at it,
 * because a browser's PDF viewer honours a `#page=` fragment.
 */
export const PASSAGE_LOCATOR = {
  label(hit: PassageHit): string {
    return `${hit.pageNumbered ? 'Page' : 'Passage'} ${hit.locator}`;
  },

  /**
   * No link where the locator is not a page: a fragment the viewer ignores is a broken promise.
   * Nor where the file has no address of its own, as a presigned download does not.
   */
  href(row: PassageRow, hit: PassageHit): string | undefined {
    return hit.pageNumbered && row.href ? `${row.href}#page=${hit.locator}` : undefined;
  },
};
