import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ConfigService } from '../../services/config.service';
import { RegistryStateService } from '../../services/registry-state.service';
import { readPrefs } from '../../shell/prefs';
import type {
  AdvancedField,
  FilterValue,
  GridColumn,
  GridTemplate,
  PassageRow,
  SortOption,
  ValueOption,
} from '../../search/grid-types';
import { columnFiltersForPanel, sortStateOf } from '../../search/grid-types';
import {
  DEFAULT_PAGE_SIZE,
  INSIDE_SORT,
  PAGE_SIZES,
  RECORD_TYPES,
  type RecordType,
  type SearchScope,
} from '../../search/grid-url';
import { recordConfig, type OptionSource } from '../../search/record-types';
import { attachmentsOf, isoDay, plainText, projectOf, subjectName } from '../../search/record-types/activities';
import { projectPath } from '../../search/record-types/record-type';
import { yearOptions } from '../../search/search-filters';
import { SearchGridUrlService } from '../../search/search-grid-url.service';
import {
  UnifiedSearchService,
  passageRowFrom,
  searchKeyword,
} from '../../search/unified-search.service';
import { AdvancedFiltersComponent, type PanelChange } from './display-grid/advanced-filters.component';
import { ChipRowComponent, type GridChip } from './display-grid/chip-row.component';
import { DisplayGridComponent, type SortChange } from './display-grid/display-grid.component';
import type { FilterChange } from './display-grid/filter-row.component';
import { GridToolbarComponent } from './display-grid/grid-toolbar.component';
import { GuidedTourComponent } from './display-grid/guided-tour.component';
import { SearchHelpDialogComponent } from './display-grid/search-help-dialog.component';
import { toTerms } from './display-grid/highlight';
import type { ListRowData, ListRowField, ListRowMeta } from './display-grid/list-row.component';
import { PassageListComponent } from './display-grid/passage-list.component';

type Row = Record<string, unknown>;

/** The two ways the documents tab can be read. */
export const SCOPE_OPTIONS: { value: SearchScope; label: string }[] = [
  { value: 'names', label: 'Names & details' },
  { value: 'inside', label: 'Inside documents' },
];

/** The text inside the files: one row per document, carrying the passages that matched. */
export const INSIDE_DATASET = 'DocumentChunk';

/**
 * Every field of the chunk index is unsortable, so relevance is the only order the scope has, and
 * the URL spells it `-matches` because that is what the reader is choosing.
 */
const INSIDE_SORT_OPTIONS: SortOption[] = [{ value: INSIDE_SORT, label: 'Most matches' }];

/** demi-search reads `-score` as "issue no $orderby", which leaves the relevance ranking in place. */
const INSIDE_WIRE_SORT = '-score';

/** The config key that says this environment can search the text inside the documents. */
export const CONTENT_SEARCH_KEY = 'CONTENT_SEARCH';

/** demi-search answers 400 for `and[nameContains]` on the chunk dataset: it filters names only. */
const NAMES_ONLY_FILTERS = ['nameContains'];

/** A Mongo id is a database key, never a word the reader asked to see. */
const OBJECT_ID = /^[0-9a-f]{24}$/i;

/** A date in the grid is YYYY-MM-DD, read in UTC: the stored date is a day, not an instant. */
function gridDate(value: unknown): string {
  if (!value) return '';
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10);
}

/** A stored pick as its name. Populated rows carry the whole record, bare ones carry the id. */
function pickText(options: ValueOption[], pick: unknown): string {
  const raw =
    pick && typeof pick === 'object'
      ? String((pick as Record<string, unknown>)['name'] ?? (pick as Record<string, unknown>)['_id'] ?? '')
      : String(pick ?? '');
  const label = options.find((option) => option.value === raw)?.label;
  if (label !== undefined) return label;
  // A bare `6a61123ff0c29b9e36505fd7` in an Author cell tells the reader less than a blank.
  return OBJECT_ID.test(raw) ? '' : raw;
}

function optionText(options: ValueOption[], value: unknown): string {
  return (Array.isArray(value) ? value : [value])
    .map((pick) => pickText(options, pick))
    .filter(Boolean)
    .join(', ');
}

/**
 * The one search page: a keyword, a record type, and the shared grid configured by that type.
 * Everything the reader chooses lives in the URL, so a view can be linked and shared.
 */
@Component({
  selector: 'app-unified-search',
  standalone: true,
  imports: [
    AdvancedFiltersComponent,
    ChipRowComponent,
    DisplayGridComponent,
    GridToolbarComponent,
    GuidedTourComponent,
    PassageListComponent,
    SearchHelpDialogComponent,
  ],
  templateUrl: './unified-search.component.html',
  styleUrls: ['./unified-search.css'],
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class UnifiedSearchComponent implements OnInit {
  private registry = inject(RegistryStateService);
  private appConfig = inject(ConfigService);
  private url = inject(SearchGridUrlService);
  search = inject(UnifiedSearchService);

  /** "Results per page" as the reader set it, where it is one of the sizes this grid offers. */
  private preferredPageSize = PAGE_SIZES.includes(readPrefs().perPage)
    ? readPrefs().perPage
    : DEFAULT_PAGE_SIZE;

  readonly tabs = RECORD_TYPES;

  private lists = signal<OptionSource[]>([]);
  private orgs = signal<OptionSource[]>([]);

  panelOpen = signal(false);
  downloadError = signal<string | null>(null);

  /** The last request issued, so a keyword the floor swallows does not re-ask the same question. */
  private lastQuery = '';

  readonly scopeOptions = SCOPE_OPTIONS;

  /**
   * Whether this environment can search the text inside the documents. A `scope=inside` address in
   * one that cannot reads as the names scope rather than as an empty page.
   */
  readonly contentSearchEnabled = this.appConfig.get(CONTENT_SEARCH_KEY) === true;

  state = this.url.state;
  config = computed(() => recordConfig(this.state().record));
  sortState = computed(() => sortStateOf(this.state().sortBy));

  scopeShown = computed(() => this.state().record === 'documents' && this.contentSearchEnabled);
  inside = computed(() => this.scopeShown() && this.state().scope === 'inside');

  /** Nothing to search inside until there is a word to look for: the API answers none with none. */
  insidePrompt = computed(() => this.inside() && !searchKeyword(this.state().keywords));

  /**
   * The filters the scope in force can answer. The rest are neither sent, offered nor shown as a
   * chip inside the documents, and come back on the way out of the scope.
   */
  private scopeFilters = computed(() =>
    Object.fromEntries(
      Object.entries(this.state().filters).filter(([id]) => this.scopeTakes(id)),
    ),
  );

  /** The record's own columns, less the ones the scope in force cannot narrow by. */
  private scopeColumns = computed(() =>
    this.config().columns.filter((column) => this.scopeTakes(column.filterId ?? column.key)),
  );

  /** Inside the documents the page draws the passages itself, so the grid keeps only its frame. */
  template = computed<GridTemplate>(() => (this.inside() ? 'list' : this.config().template));

  sortOptions = computed<SortOption[] | undefined>(() =>
    this.inside() ? INSIDE_SORT_OPTIONS : undefined,
  );

  terms = computed(() => toTerms(searchKeyword(this.state().keywords)));

  passageRows = computed<PassageRow[]>(() =>
    this.inside() ? this.search.rows().map((row) => passageRowFrom(row, '')) : [],
  );

  /** Dropdown values per filter id, from the cached `List` and `Organization` reads. */
  options = computed(() => this.config().optionsFrom(this.lists(), this.orgs()));

  columns = computed<GridColumn<Row>[]>(() => {
    const options = this.options();
    const hidden = this.state().hiddenColumns;
    const filters = this.scopeFilters();
    return this.scopeColumns()
      .filter((column) => !hidden.includes(column.key))
      .map((column) => {
        const id = column.filterId ?? column.key;
        const picks = options[id] ?? column.options;
        return {
          ...column,
          sortable: true,
          // A year column offers the years the record spans, plus whichever year is filtered on.
          options: column.filter === 'year' ? yearOptions(asText(filters[id])) : picks,
          // A values column stores ids; without the lookup the cell shows a raw ObjectId.
          render: column.render ?? cellRenderer(column, picks),
        };
      });
  });

  advancedFields = computed<AdvancedField[]>(() =>
    this.config().advancedFields.map((field) =>
      field.kind === 'select' ? { ...field, options: this.options()[field.id] ?? field.options } : field,
    ),
  );

  private grid = viewChild(DisplayGridComponent);

  private help = viewChild(SearchHelpDialogComponent);
  private tour = viewChild(GuidedTourComponent);
  private helpButton = viewChild<ElementRef<HTMLButtonElement>>('helpButton');

  /** Whether the help dialog is showing, which the link that opened it has to report. */
  helpOpen = computed(() => this.help()?.opened() ?? false);

  /** Both the dialog and the tour hand focus back to the link that opened them. */
  openHelp(): void {
    this.help()?.open(this.helpButton()?.nativeElement);
  }

  startTour(): void {
    this.tour()?.start(this.helpButton()?.nativeElement);
  }

  /**
   * The record's own fields first, then the column filters the layout left nowhere else to live:
   * a list, a headerless type, a narrow card or an empty result draws no filter row.
   */
  panelFields = computed<AdvancedField[]>(() =>
    this.grid()?.showFilterRow()
      ? this.advancedFields()
      : [...this.advancedFields(), ...columnFiltersForPanel(this.columns())],
  );

  chips = computed<GridChip[]>(() => {
    const state = this.state();
    const chips: GridChip[] = [];
    if (state.keywords) chips.push({ id: 'keywords', label: 'Search', value: state.keywords });
    for (const [id, value] of Object.entries(this.scopeFilters())) {
      const label = this.labelOfFilter(id);
      if (this.textFilterIds().includes(id)) {
        const typed = asText(value).trim();
        if (typed !== '') chips.push({ id, label, value: typed });
        continue;
      }
      for (const pick of Array.isArray(value) ? value : [value]) {
        chips.push({ id, label, value: labelOfValue(this.options()[id] ?? [], pick) });
      }
    }
    return chips;
  });

  /** How many panel fields are applied, merged column filters included; the More filters badge. */
  advancedCount = computed(
    () => this.panelFields().filter((field) => this.state().filters[field.id] != null).length,
  );

  narrowed = computed(
    () => !!searchKeyword(this.state().keywords) || Object.keys(this.state().filters).length > 0,
  );

  noun = computed(() => this.config().noun ?? this.config().label.toLowerCase());

  caption = computed(() => `${this.config().label} matching this search`);

  emptyMessage = computed(() => {
    const term = searchKeyword(this.state().keywords);
    if (term) return `Nothing in ${this.noun()} matches “${term}”`;
    return Object.keys(this.state().filters).length > 0
      ? `No ${this.noun()} match these filters`
      : `No ${this.noun()} found`;
  });

  /** The columns whose filter is a year; their value stands for a range, not a date. */
  private yearFilterIds = computed(() => this.filterIdsOfKind('year'));
  /** The columns whose filter is typed; one string rather than a list of picks. */
  private textFilterIds = computed(() => this.filterIdsOfKind('text'));

  constructor() {
    effect(() => {
      const state = this.state();
      const inside = this.inside();
      const prompt = this.insidePrompt();
      const filters = this.scopeFilters();
      const config = untracked(() => this.config());
      const key = JSON.stringify([
        state.record,
        inside,
        searchKeyword(state.keywords),
        state.sortBy,
        state.currentPage,
        state.pageSize,
        filters,
      ]);
      // A keystroke the two-character floor swallows asks the same question as the last one did.
      if (key === this.lastQuery) return;
      this.lastQuery = key;
      // A chunk search without a keyword comes back empty by design, so the scope prompts instead.
      if (prompt) return;
      untracked(() =>
        this.search.queueSearch({
          dataset: inside ? INSIDE_DATASET : config.dataset,
          keywords: state.keywords,
          pageNum: state.currentPage,
          pageSize: state.pageSize,
          sortBy: inside ? INSIDE_WIRE_SORT : state.sortBy,
          filters,
          yearIds: this.yearFilterIds(),
          textIds: this.textFilterIds(),
        }),
      );
    });
  }

  /** Whether the scope in force can narrow by a filter id. The one place that rule is read. */
  private scopeTakes(id: string): boolean {
    return !this.inside() || !NAMES_ONLY_FILTERS.includes(id);
  }

  setScope(scope: SearchScope): void {
    if (scope === this.state().scope) return;
    this.panelOpen.set(false);
    this.url.setScope(scope);
  }

  /** The sort select names a direction, where a header click leaves it to the URL it flips. */
  onSortPicked(change: SortChange): void {
    this.url.setSort(change.key, change.dir);
  }

  /** One update or one notification as the list template draws it. */
  listRow = (row: Row): ListRowData => {
    if (this.config().rowTemplate === 'activity') return this.activityRow(row);
    return this.notificationRow(row);
  };

  private activityRow(row: Row): ListRowData {
    const { id } = projectOf(row);
    const subject = subjectName(row);
    const kind = String(row['type'] ?? '');
    const posted = isoDay(row['dateAdded']);

    const meta: ListRowMeta[] = [];
    if (posted) meta.push({ text: posted });
    if (kind) meta.push({ text: kind });
    if (subject) meta.push({ text: subject, href: id === '' ? undefined : projectPath(id) });

    return {
      meta,
      title: String(row['headline'] ?? ''),
      body: plainText(row['content']),
      attachments: attachmentsOf(row),
    };
  }

  private notificationRow(row: Row): ListRowData {
    const projectId = String(row['associatedProjectId'] ?? '');
    const fields: ListRowField[] = [];
    for (const column of this.config().columns) {
      if (column.link) continue;
      // The record stores codes; the filter's own options are where their labels live.
      const picks = this.options()[column.filterId ?? column.key];
      const value = picks
        ? optionText(picks, row[column.key])
        : column.render
          ? column.render(row)
          : String(row[column.key] ?? '');
      if (value) fields.push({ label: column.label, value });
    }
    return {
      meta: [],
      title: String(row['name'] ?? ''),
      href: projectId === '' ? undefined : projectPath(projectId),
      fields,
    };
  }

  ngOnInit(): void {
    this.url.setDefaults(this.defaultsFor(this.state().record));
    void this.loadOptions();
  }

  onKeywordInput(event: Event): void {
    this.url.setKeyword((event.target as HTMLInputElement).value);
  }

  /** Filters and sort belong to one record type; the keyword carries across. */
  switchRecord(record: RecordType): void {
    if (record === this.state().record) return;
    this.panelOpen.set(false);
    this.url.setRecord(record, this.defaultsFor(record));
  }

  countOf(record: RecordType): number | null {
    return this.search.counts()?.[record] ?? null;
  }

  labelOf(record: RecordType): string {
    return recordConfig(record).label;
  }

  onSort(key: string): void {
    this.url.setSort(key, '+');
  }

  onFilterChange(change: FilterChange): void {
    this.url.setFilter(change.id, change.value);
  }

  onPanelChange(change: PanelChange): void {
    this.url.setFilter(change.id, change.value);
  }

  onToggleColumn(key: string): void {
    const hidden = this.state().hiddenColumns;
    this.url.setHiddenColumns(
      hidden.includes(key) ? hidden.filter((item) => item !== key) : [...hidden, key],
    );
  }

  removeChip(chip: GridChip): void {
    if (chip.id === 'keywords') {
      this.url.setKeyword('');
      return;
    }
    const current = this.state().filters[chip.id];
    if (chip.value !== undefined && Array.isArray(current)) {
      const raw = valueOfLabel(this.options()[chip.id] ?? [], chip.value);
      const next = current.filter((pick) => pick !== raw);
      this.url.setFilter(chip.id, next.length > 0 ? next : null);
      return;
    }
    this.url.setFilter(chip.id, null);
  }

  clearAll(): void {
    this.url.clearAll();
  }

  setPage(page: number): void {
    this.url.setPage(page);
  }

  setPageSize(pageSize: number): void {
    this.url.setPageSize(pageSize);
  }

  /** The narrow card has room the table never had, so it carries the panel-only attributes. */
  narrowExtras = (row: Row): ListRowField[] => {
    const pairs: ListRowField[] = [];
    for (const field of this.advancedFields()) {
      const value = row[field.id];
      if (field.kind === 'toggle') {
        if (value) pairs.push({ label: field.label, value: 'Yes' });
        continue;
      }
      if (field.kind !== 'select' || value == null || value === '') continue;
      pairs.push({ label: field.label, value: optionText(this.options()[field.id] ?? [], value) });
    }
    return pairs;
  };

  /** A document cell hands back the file's id; the API mints the presigned URL on the press. */
  async onDownload(documentId: string): Promise<void> {
    this.downloadError.set(null);
    try {
      const url = await this.registry.getDownloadUrl(documentId);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      this.downloadError.set(
        err instanceof Error ? err.message : 'Could not prepare the download.',
      );
    }
  }

  /**
   * The record type is not defaulted to the one on screen: that would drop `record` from the
   * address bar, and the link would come back on whichever type a bare `/search` lists.
   */
  private defaultsFor(record: RecordType) {
    return {
      defaultSort: recordConfig(record).defaultSort,
      defaultPageSize: this.preferredPageSize,
    };
  }

  private filterIdsOfKind(kind: 'year' | 'text'): string[] {
    return this.config()
      .columns.filter((column) => column.filter === kind)
      .map((column) => column.filterId ?? column.key);
  }

  private labelOfFilter(id: string): string {
    const column = this.config().columns.find((item) => (item.filterId ?? item.key) === id);
    if (column) return column.label;
    return this.advancedFields().find((field) => field.id === id)?.label ?? id;
  }

  private async loadOptions(): Promise<void> {
    const [lists, orgs] = await Promise.all([
      this.search.loadLists(),
      this.search.loadOrganizations(),
    ]);
    this.lists.set(lists);
    this.orgs.set(orgs);
  }
}

/** A filter value as one string; a multi-select holds a list, a year holds one. */
function asText(value: FilterValue | undefined): string {
  if (value == null) return '';
  return Array.isArray(value) ? value.join(',') : value;
}

function labelOfValue(options: ValueOption[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

function valueOfLabel(options: ValueOption[], label: string): string {
  return options.find((option) => option.label === label)?.value ?? label;
}

function cellRenderer(
  column: GridColumn<Row>,
  picks: ValueOption[] | undefined,
): ((row: Row) => string) | undefined {
  // A date is read, never looked up: the years a date column offers are not its cell values.
  if (column.date) return (row) => gridDate(row[column.key]);
  if (picks) return (row) => optionText(picks, row[column.key]);
  return undefined;
}
