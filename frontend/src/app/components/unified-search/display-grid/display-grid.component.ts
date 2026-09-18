import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ViewEncapsulation,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type {
  FilterValues,
  GridCell,
  GridColumn,
  GridTemplate,
  SortOption,
  SortState,
} from '../../../search/grid-types';
import { sortValueOf } from '../../../search/grid-types';
import { FilterRowComponent, type FilterChange } from './filter-row.component';
import { GridFooterComponent } from './grid-footer.component';
import { GridHeaderComponent } from './grid-header.component';
import { HighlightComponent } from './highlight.component';
import { toTerms } from './highlight';
import {
  ListRowComponent,
  type ListRowData,
  type ListRowField,
  type ListRowMeta,
} from './list-row.component';
import { RecordLinkComponent } from './record-link.component';
import { RecordDetailComponent, type RecordDetail } from '../record-detail.component';

type Row = Record<string, unknown>;

/**
 * A press inside one of these keeps the control's own behaviour, so a download, an external link
 * or a checkbox still does what it says. The rest of the row opens the record.
 */
const INTERACTIVE = 'a[href], button, input, select, textarea, label, [role="button"]';

/** The row's own name, which opens the record rather than following its href. */
const NAME_TARGET = '[data-record-name]';

/** Row attributes no column carries that the detail still names. */
const DETAIL_EXTRA_FIELDS: { key: string; label: string }[] = [{ key: 'status', label: 'Status' }];

/** The record's own prose, where the type carries any. */
const DETAIL_BODY_KEY = 'description';

/** A sort direction as the select hands one back. */
export interface SortChange {
  key: string;
  dir: '+' | '-';
}

/**
 * What the sort select offers where the columns are not on screen: the record's own date and its
 * name, in both directions. The order in force is added where no option already names it, because
 * a select whose value matches no option shows its first one, telling a phone reader the cards are
 * in an order they are not.
 */
function sortOptionsFor(columns: GridColumn<Row>[], sort: SortState | null): SortOption[] {
  const date =
    columns.find((column) => column.primaryDate) ?? columns.find((column) => column.date);
  const name = columns.find((column) => column.link) ?? columns.find((column) => column.sortable);
  const options: SortOption[] = [];
  if (date?.sortable) {
    options.push(
      { value: `-${date.key}`, label: 'Newest first' },
      { value: `+${date.key}`, label: 'Oldest first' },
    );
  }
  if (name?.sortable) {
    options.push(
      { value: `+${name.key}`, label: 'Name A–Z' },
      { value: `-${name.key}`, label: 'Name Z–A' },
    );
  }
  if (sort && !options.some((option) => option.value === sortValueOf(sort))) {
    const column = columns.find((item) => item.key === sort.key);
    if (column) options.push({ value: sortValueOf(sort), label: column.label });
  }
  return options;
}

/** Enough rows to read as a table; a full page of them would be a bigger jump than it saves. */
const SKELETON_ROWS = 5;

/**
 * Below this the table becomes one card per record: seven columns cannot be read on a phone, and
 * a sideways scroll hides whichever of them the reader has not thought to look for.
 */
export const NARROW_QUERY = '(max-width: 719.98px)';

/** A cell's plain text, where the column names no renderer. */
function readCell(row: Row, key: string): string {
  const value = row[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

/**
 * The result table: headings, filter row, rows and pager, or one card per record where the screen
 * is too narrow for columns. Everything it draws is driven by the record type's column list.
 */
@Component({
  selector: 'app-display-grid',
  standalone: true,
  imports: [
    FilterRowComponent,
    GridFooterComponent,
    GridHeaderComponent,
    HighlightComponent,
    ListRowComponent,
    RecordDetailComponent,
    RecordLinkComponent,
  ],
  templateUrl: './display-grid.component.html',
  styleUrls: [
    './display-grid.css',
    './chip-row.css',
    './advanced-filters.css',
    './list-row.css',
    './passage-list.css',
    './highlight.css',
    './display-grid.reset.css',
  ],
  // The ported stylesheets are namespaced under `.display-grid` and styling children is the point.
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class DisplayGridComponent {
  /** Visually-hidden caption naming what the grid lists. */
  caption = input('Results');
  columns = input<GridColumn<Row>[]>([]);
  rows = input<Row[]>([]);
  loading = input(false);
  /** What was searched for, so a cell can mark the words that matched. */
  keywords = input('');
  emptyMessage = input('No results found');
  sort = input<SortState | null>(null);
  filters = input<FilterValues>({});
  page = input(1);
  pageSize = input(25);
  total = input(0);
  /** Record attributes no column carries, shown on the narrow card where there is room for them. */
  narrowExtras = input<(row: Row) => ListRowField[]>(() => []);
  /** `list` draws one full-width row per record instead of a table of cells. */
  template = input<GridTemplate>('grid');
  /** No column headings and no filter row: the column filters move into the panel. */
  headerless = input(false);
  /** One record as a list row. Required by the `list` template, ignored by the others. */
  listRow = input<(row: Row) => ListRowData>(() => ({ meta: [], title: '' }));
  /** What the sort select offers, where the columns are not the orders available. */
  sortOptions = input<SortOption[] | undefined>(undefined);
  /** The caller draws the records itself — passages inside the documents, say. */
  customBody = input(false);
  /** Page sizes and pager. Off where there is no result set to page: a prompt, not an answer. */
  footer = input(true);

  sorted = output<string>();
  /** The sort select names a direction; a header click leaves it to the URL it is flipping. */
  sortPicked = output<SortChange>();
  filterChanged = output<FilterChange>();
  pageChange = output<number>();
  pageSizeChange = output<number>();
  /** A cell whose target is a presigned file: the page asks the API for the URL. */
  downloadRequested = output<string>();

  readonly skeletonRows = Array.from({ length: SKELETON_ROWS }, (_, index) => index);

  private destroyRef = inject(DestroyRef);

  private narrowSignal = signal(false);

  private detailRef = viewChild(RecordDetailComponent);

  constructor() {
    const query = window.matchMedia(NARROW_QUERY);
    this.narrowSignal.set(query.matches);
    const onChange = (event: MediaQueryListEvent) => this.narrowSignal.set(event.matches);
    query.addEventListener('change', onChange);
    this.destroyRef.onDestroy(() => query.removeEventListener('change', onChange));
  }

  /** What was searched for, as the match scanner reads it. */
  terms = computed(() => toTerms(this.keywords()));

  listMode = computed(() => this.template() === 'list');
  showSkeleton = computed(() => this.loading() && this.rows().length === 0);
  showEmpty = computed(() => !this.customBody() && !this.loading() && this.rows().length === 0);
  /** One record per card below the breakpoint; a switched-off column is off in both layouts. */
  cardMode = computed(() => this.narrowSignal() && !this.listMode() && !this.showEmpty());
  showHead = computed(
    () =>
      !this.listMode() &&
      !this.headerless() &&
      !this.cardMode() &&
      (!this.showEmpty() || this.anyFilterSet()),
  );
  showFilterRow = computed(() => this.showHead() && this.columns().some((column) => !!column.filter));

  sortChoices = computed(() => this.sortOptions() ?? sortOptionsFor(this.columns(), this.sort()));
  showSortBar = computed(
    () =>
      !this.showEmpty() &&
      (this.listMode() || this.cardMode()) &&
      this.sortChoices().length > 0,
  );
  sortValue = computed(() => {
    const sort = this.sort();
    return sort ? sortValueOf(sort) : '';
  });

  onSortPicked(event: Event): void {
    const next = (event.target as HTMLSelectElement).value;
    this.sortPicked.emit({ key: next.slice(1), dir: next.startsWith('-') ? '-' : '+' });
  }

  /** The card's headline and its meta line: the link column and the record's own date. */
  headline = computed(
    () => this.columns().find((column) => column.link) ?? this.columns()[0] ?? null,
  );
  dateColumn = computed(
    () =>
      this.columns().find((column) => column.primaryDate) ??
      this.columns().find((column) => column.date) ??
      null,
  );

  /** One cell's content as the template switches on it. */
  cellOf(row: Row, column: GridColumn<Row>): GridCell {
    if (column.cell) return column.cell(row);
    const text = this.textOf(row, column);
    if (!column.link) return { kind: 'text', text };
    const href = column.href?.(row);
    return href
      ? { kind: 'link', text, href, external: column.hrefExternal }
      : { kind: 'text', text };
  }

  badgeOf(row: Row, column: GridColumn<Row>): GridCell | undefined {
    return column.badge?.(row);
  }

  cardTitle(row: Row): string {
    const column = this.headline();
    return column ? this.textOf(row, column) : '';
  }

  cardMeta(row: Row): ListRowMeta[] {
    const column = this.dateColumn();
    if (!column) return [];
    const text = this.textOf(row, column);
    return text ? [{ text }] : [];
  }

  /** The card's label/value pairs: every column that is neither the headline nor the date. */
  cardFields(row: Row): ListRowField[] {
    const pairs = this.columns()
      .filter((column) => !column.link && !column.date)
      .map((column) => ({
        label: column.label,
        value: this.textOf(row, column),
      }));
    return [...pairs, ...this.narrowExtras()(row)];
  }

  cardCell(row: Row): GridCell | null {
    const column = this.headline();
    return column ? this.cellOf(row, column) : null;
  }

  /**
   * A press on a row opens the record rather than leaving the result set for its own page. The
   * name keeps its `href` so middle-click and copy still work, which is why only an unmodified
   * left press is turned back here.
   */
  openDetail(row: Row, event: MouseEvent): void {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    const pressed = (event.target as Element | null)?.closest(INTERACTIVE) ?? null;
    if (pressed && !pressed.closest(NAME_TARGET)) return;
    if (pressed) event.preventDefault();
    const opener = (pressed ?? event.currentTarget) as HTMLElement | null;
    this.detailRef()?.open(this.detailOf(row), opener ?? undefined);
  }

  /**
   * One record as the dialog reads it, from the same column config the grid draws with, so a new
   * record type gains a detail sheet by declaring its columns.
   */
  private detailOf(row: Row): RecordDetail {
    if (this.listMode()) {
      const data = this.listRow()(row);
      return {
        title: data.title,
        meta: data.meta,
        fields: data.fields ?? [],
        body: data.body,
        attachments: data.attachments,
        link: data.href
          ? { href: data.href, label: 'Open record', external: data.external }
          : undefined,
      };
    }

    const date = this.dateColumn();
    const extras = DETAIL_EXTRA_FIELDS.map((extra) => ({
      label: extra.label,
      value: readCell(row, extra.key),
    }));
    const fields = [
      ...(date ? [{ label: date.label, value: this.textOf(row, date) }] : []),
      ...this.cardFields(row),
      ...extras,
    ].filter((field) => field.value !== '');

    const cell = this.cardCell(row);
    const headline = this.headline();
    const detail: RecordDetail = {
      title: this.cardTitle(row),
      meta: [],
      fields,
      body: readCell(row, DETAIL_BODY_KEY) || undefined,
    };
    if (cell?.kind === 'link' && headline) {
      detail.link = {
        href: cell.href,
        label: `Open ${headline.label.toLowerCase()} page`,
        external: cell.external,
      };
    }
    if (cell?.kind === 'download') detail.documentId = cell.documentId;
    return detail;
  }

  /** A column's plain text, whichever way the config states it. */
  private textOf(row: Row, column: GridColumn<Row>): string {
    return column.render ? column.render(row) : readCell(row, column.key);
  }

  rowId(row: Row, index: number): string {
    const id = row['_id'] ?? row['documentId'];
    return typeof id === 'string' && id !== '' ? id : String(index);
  }

  /** Whether any filter carries a value; a blank string is no narrowing. */
  private anyFilterSet(): boolean {
    return Object.values(this.filters()).some((value) =>
      Array.isArray(value) ? value.length > 0 : value.trim() !== '',
    );
  }
}
