import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { config as appConfig } from '../config';
import { useDownload } from '../hooks/useDownload';
import {
  sortStateOf,
  type AdvancedField,
  type FilterValue,
  type GridColumn,
  type SortOption,
  type ValueOption,
} from '../search/grid-types';
import {
  DEFAULT_PAGE_SIZE,
  INSIDE_SORT,
  RECORD_TYPES,
  parseGridParams,
  type RecordType,
  type SearchScope,
} from '../search/grid-url';
import { toTerms } from '../search/highlight';
import { DisplayGrid, GridToolbar } from '../search/grid/DisplayGrid';
import { asText } from '../search/grid/grid-format';
import { GuidedTour } from '../search/grid/GuidedTour';
import { SearchHelpDialog } from '../search/grid/SearchHelpDialog';
import {
  AdvancedFilters,
  ChipRow,
  PassageList,
  type GridChip,
  type ListRowData,
  type ListRowField,
  type ListRowMeta,
} from '../search/grid/parts';
import { recordConfig, projectPath } from '../search/record-types';
import {
  attachmentsOf,
  isoDay,
  plainText,
  projectOf,
  subjectName,
} from '../search/record-types/activities';
import {
  SEARCH_DEBOUNCE_MS,
  passageRowFrom,
  runSearch,
  searchKeyword,
  useFilterSources,
  useTypeCounts,
  type SearchResult,
} from '../search/search-api';
import { yearOptions } from '../search/search-filters';
import { useGridUrlState } from '../search/use-grid-url-state';
import { useSettled } from '../search/use-settled';
import '../search/unified-search.css';

type Row = Record<string, unknown>;

const SCOPE_OPTIONS: { value: SearchScope; label: string }[] = [
  { value: 'names', label: 'Names & details' },
  { value: 'inside', label: 'Inside documents' },
];

/** The text inside the files: one row per document, carrying the passages that matched. */
const INSIDE_DATASET = 'DocumentChunk';

/** Every chunk field is unsortable, so relevance is the only order; the URL spells it `-matches`. */
const INSIDE_SORT_OPTIONS: SortOption[] = [{ value: INSIDE_SORT, label: 'Most matches' }];

/** demi-search reads `-score` as "issue no $orderby", which leaves the relevance ranking in place. */
const INSIDE_WIRE_SORT = '-score';

/** demi-search answers 400 for `and[nameContains]` on the chunk dataset: it filters names only. */
const NAMES_ONLY_FILTERS = ['nameContains'];

/** What one search asks for, as the second part of its query key. */
interface SearchKey {
  record: RecordType;
  inside: boolean;
  term: string;
  sortBy: string;
  page: number;
  pageSize: number;
  filters: string;
}

const OBJECT_ID = /^[0-9a-f]{24}$/i;

/** A date in the grid is YYYY-MM-DD, read in UTC: the stored date is a day, not an instant. */
function gridDate(value: unknown): string {
  if (!value) return '';
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10);
}

/** A stored pick as its name. Populated rows carry the whole record, bare ones carry the id. */
function pickText(options: ValueOption[], pick: unknown): string {
  const held = pick && typeof pick === 'object' ? (pick as Record<string, unknown>) : null;
  const raw = held ? String(held['name'] ?? held['_id'] ?? '') : String(pick ?? '');
  const label = options.find((option) => option.value === raw)?.label;
  if (label !== undefined) return label;
  // A bare ObjectId in an Author cell tells the reader less than a blank.
  return OBJECT_ID.test(raw) ? '' : raw;
}

function optionText(options: ValueOption[], value: unknown): string {
  return (Array.isArray(value) ? value : [value])
    .map((pick) => pickText(options, pick))
    .filter(Boolean)
    .join(', ');
}

function cellRenderer(column: GridColumn<Row>, picks: ValueOption[] | undefined): ((row: Row) => string) | undefined {
  // A date is read, never looked up: the years a date column offers are not its cell values.
  if (column.date) return (row) => gridDate(row[column.key]);
  if (picks) return (row) => optionText(picks, row[column.key]);
  return undefined;
}

const NO_ROWS: SearchResult['rows'] = [];

/** The filters each record declares. Any other query parameter (a tracking tag, a crafted name) is dropped. */
const DECLARED_FILTERS = Object.fromEntries(
  RECORD_TYPES.map((record) => {
    const { columns, advancedFields } = recordConfig(record);
    const ids = [...columns.map((column) => column.filterId ?? column.key), ...advancedFields.map((field) => field.id)];
    return [record, ids];
  }),
) as Record<RecordType, string[]>;

const labelOfValue = (options: ValueOption[], value: string) =>
  options.find((option) => option.value === value)?.label ?? value;

/**
 * The one search page: a keyword, a record type, and the shared grid configured by that type.
 * Everything the reader chooses lives in the URL, so a view can be linked and shared.
 */
export function UnifiedSearch() {
  // The record decides the default sort, which the URL state needs before it can be read.
  const [params] = useSearchParams();
  const url = useGridUrlState({
    defaultSort: recordConfig(parseGridParams(params).record).defaultSort,
    defaultPageSize: DEFAULT_PAGE_SIZE,
  });
  const { state } = url;
  const config = recordConfig(state.record);

  const { lists, orgs } = useFilterSources();
  const download = useDownload();
  const [panelOpen, setPanelOpen] = useState(false);
  // Both the help dialog and the tour hand focus back to the button that opened them.
  const helpButton = useRef<HTMLButtonElement>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [touring, setTouring] = useState(false);
  const closeHelp = useCallback((startTour: boolean) => {
    setHelpOpen(false);
    if (startTour) setTouring(true);
    else helpButton.current?.focus();
  }, []);
  const endTour = useCallback(() => setTouring(false), []);

  const contentSearchEnabled = appConfig()['CONTENT_SEARCH'] === true;
  const scopeShown = state.record === 'documents' && contentSearchEnabled;
  const inside = scopeShown && state.scope === 'inside';
  const term = searchKeyword(state.keywords);
  const insidePrompt = inside && !term;

  /* The field holds what is being typed; the URL holds what has been searched for. */
  const [draft, setDraft] = useState(state.keywords);
  const settledDraft = useSettled(draft, SEARCH_DEBOUNCE_MS);
  const [lastUrlKeyword, setLastUrlKeyword] = useState(state.keywords);
  if (state.keywords !== lastUrlKeyword) {
    setLastUrlKeyword(state.keywords);
    // A keyword this page did not write (Clear all, a chip, back) wins over the draft.
    if (state.keywords !== settledDraft) setDraft(state.keywords);
  }
  const { setKeyword } = url;
  // Written only when the settled draft moves: a URL change alone would otherwise hand the old word back.
  const written = useRef(settledDraft);
  useEffect(() => {
    if (settledDraft === written.current) return;
    written.current = settledDraft;
    if (settledDraft !== state.keywords) setKeyword(settledDraft);
  }, [settledDraft, state.keywords, setKeyword]);

  const counts = useTypeCounts(settledDraft);

  const scopeTakes = (id: string) => !inside || !NAMES_ONLY_FILTERS.includes(id);
  const filters = Object.fromEntries(
    Object.entries(state.filters).filter(([id]) => DECLARED_FILTERS[state.record].includes(id) && scopeTakes(id)),
  );
  const options = useMemo(() => config.optionsFrom(lists, orgs), [config, lists, orgs]);

  const columns: GridColumn<Row>[] = config.columns
    .filter((column) => scopeTakes(column.filterId ?? column.key) && !state.hiddenColumns.includes(column.key))
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

  const advancedFields: AdvancedField[] = config.advancedFields
    .map((field) => (field.kind === 'select' ? { ...field, options: options[field.id] ?? field.options } : field));

  const idsOfKind = (kind: 'year' | 'text') =>
    config.columns.filter((column) => column.filter === kind).map((column) => column.filterId ?? column.key);
  const yearIds = idsOfKind('year');
  const textIds = idsOfKind('text');

  // A sort the URL names that this record cannot sort by falls back to the record's own.
  const sortKey = state.sortBy.replace(/^[+-]/, '');
  const sortable = state.sortBy === config.defaultSort || config.columns.some((column) => column.key === sortKey);
  const sortBy = sortable ? state.sortBy : config.defaultSort;
  const searchKey: SearchKey = {
    record: state.record,
    inside,
    term,
    sortBy,
    page: state.currentPage,
    pageSize: state.pageSize,
    filters: JSON.stringify(filters),
  };
  const search = useQuery({
    queryKey: ['unified-search', searchKey],
    enabled: !insidePrompt,
    queryFn: ({ signal }) =>
      runSearch(
        {
          dataset: inside ? INSIDE_DATASET : config.dataset,
          keywords: term,
          pageNum: state.currentPage,
          pageSize: state.pageSize,
          sortBy: inside ? INSIDE_WIRE_SORT : sortBy,
          filters,
          yearIds,
          textIds,
        },
        signal,
      ),
    /* The last page stays up while a page or filter changes. Across a record type or scope the old
       rows are another shape, so they are dropped and the grid shows it is loading. */
    placeholderData: (previous, previousQuery) => {
      const was = previousQuery?.queryKey[1] as SearchKey | undefined;
      return was?.record === state.record && was.inside === inside ? previous : undefined;
    },
  });

  // A failed search leaves the last answer for this record and scope on screen, as a failed page
  // change should not blank the grid.
  const [kept, setKept] = useState<{ record: RecordType; inside: boolean; data: SearchResult } | null>(null);
  if (search.data && search.data !== kept?.data) setKept({ record: state.record, inside, data: search.data });
  const keptData = kept && kept.record === state.record && kept.inside === inside ? kept.data : undefined;
  const shown = search.data ?? (search.isError ? keptData : undefined);

  const rows = insidePrompt ? NO_ROWS : (shown?.rows ?? NO_ROWS);
  // Held across draws: the passage list folds every passage when it is handed a new array.
  const passageRows = useMemo(() => rows.map((row) => passageRowFrom(row, '')), [rows]);
  const total = shown?.total ?? 0;
  const loading = search.isFetching && !insidePrompt;

  const labelOfFilter = (id: string) =>
    config.columns.find((item) => (item.filterId ?? item.key) === id)?.label ??
    advancedFields.find((field) => field.id === id)?.label ??
    id;

  const chips: GridChip[] = [];
  if (state.keywords) chips.push({ id: 'keywords', label: 'Search', value: state.keywords });
  for (const [id, value] of Object.entries(filters)) {
    const label = labelOfFilter(id);
    // Typed text is one narrowing however it is punctuated.
    if (textIds.includes(id)) {
      const typed = asText(value).trim();
      if (typed !== '') chips.push({ id, label, value: typed });
      continue;
    }
    for (const pick of Array.isArray(value) ? value : [value]) {
      chips.push({ id, label, value: labelOfValue(options[id] ?? [], pick), raw: pick });
    }
  }

  function removeChip(chip: GridChip): void {
    if (chip.id === 'keywords') {
      setDraft('');
      setKeyword('');
      return;
    }
    const current = state.filters[chip.id];
    if (chip.raw !== undefined && Array.isArray(current)) {
      const next = current.filter((pick) => pick !== chip.raw);
      url.setFilter(chip.id, next.length > 0 ? next : null);
      return;
    }
    url.setFilter(chip.id, null);
  }

  // Bumped by Clear all, which remounts the filter fields: a field whose value was never written
  // sees no change, and would otherwise send its pending text after the clear. A new record type
  // remounts them too, or typed text would land in the new record's filters.
  const [clears, setClears] = useState(0);
  const fieldsKey = `${state.record}:${clears}`;
  function clearAll(): void {
    setDraft('');
    setClears((count) => count + 1);
    url.clearAll();
  }

  function switchRecord(next: RecordType): void {
    if (next === state.record) return;
    setPanelOpen(false);
    url.setRecord(next, { defaultSort: recordConfig(next).defaultSort, defaultPageSize: DEFAULT_PAGE_SIZE });
  }

  function setScope(scope: SearchScope): void {
    if (scope === state.scope) return;
    setPanelOpen(false);
    url.setScope(scope);
  }

  function listRow(row: Row): ListRowData {
    if (config.rowTemplate === 'activity') {
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
    const projectId = String(row['associatedProjectId'] ?? '');
    const fields: ListRowField[] = [];
    for (const column of config.columns) {
      if (column.link) continue;
      // The record stores codes; the filter's own options are where their labels live.
      const picks = options[column.filterId ?? column.key];
      const value = picks
        ? optionText(picks, row[column.key])
        : column.render
          ? column.render(row)
          : String(row[column.key] ?? '');
      if (value) fields.push({ label: column.label, value });
    }
    const href = projectId === '' ? undefined : projectPath(projectId);
    return { meta: [], title: String(row['name'] ?? ''), href, fields };
  }

  /** The narrow card has room the table never had, so it carries the panel-only attributes. */
  function narrowExtras(row: Row): ListRowField[] {
    const pairs: ListRowField[] = [];
    for (const field of advancedFields) {
      const value = row[field.id];
      if (field.kind === 'toggle') {
        if (value) pairs.push({ label: field.label, value: 'Yes' });
        continue;
      }
      if (field.kind !== 'select' || value == null || value === '') continue;
      pairs.push({ label: field.label, value: optionText(options[field.id] ?? [], value) });
    }
    return pairs;
  }

  const noun = config.noun ?? config.label.toLowerCase();
  const filterCount = Object.keys(state.filters).length;
  const emptyMessage = term
    ? `Nothing in ${noun} matches “${term}”`
    : filterCount > 0
      ? `No ${noun} match these filters`
      : `No ${noun} found`;

  const insideBody = !inside ? undefined : insidePrompt ? (
    <div className="unified-search__prompt">
      <p className="unified-search__prompt-title">Search inside the documents</p>
      <p className="unified-search__prompt-detail">
        Type a word or phrase to find it in the text of the documents, not just their names. Results show the matching
        passage from each document.
      </p>
    </div>
  ) : (
    <PassageList
      rows={passageRows}
      terms={toTerms(term)}
      loading={search.isFetching}
      onDownload={(id) => void download.start(id)}
    />
  );

  const error = search.isError ? (search.error instanceof Error ? search.error.message : 'Search failed') : null;

  return (
    <div className="unified-search">
      <h1 className="unified-search__title">Search</h1>

      <div className="unified-search__field" data-tour="search">
        <svg
          className="unified-search__field-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <line x1="16.5" y1="16.5" x2="21" y2="21" />
        </svg>
        <label className="unified-search__field-label">
          <span className="unified-search__visually-hidden">Search projects, documents and updates</span>
          <input
            type="search"
            className="unified-search__input"
            placeholder="Search projects, documents and updates"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
      </div>

      <div className="unified-search__types-row">
        <div className="unified-search__types" data-tour="types" role="group" aria-label="Record type">
          {RECORD_TYPES.map((id) => {
            const on = id === state.record;
            const count = counts?.[id] ?? null;
            return (
              <button
                key={id}
                type="button"
                className={`unified-search__pill${on ? ' unified-search__pill--on' : ''}`}
                aria-pressed={on}
                onClick={() => switchRecord(id)}
              >
                {recordConfig(id).label}
                {/* An unknown total renders no badge: a zero would claim the type has no matches. */}
                {count !== null && <span className="unified-search__pill-count">{count.toLocaleString('en-CA')}</span>}
              </button>
            );
          })}
        </div>
        {/* A plain press gets the help in a dialog without leaving the results. */}
        <button
          ref={helpButton}
          type="button"
          className="unified-search__help"
          aria-haspopup="dialog"
          aria-expanded={helpOpen}
          onClick={() => setHelpOpen(true)}
        >
          <svg
            className="unified-search__help-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M9.5 9.5a2.5 2.5 0 1 1 3 2.45V14" />
            <line x1="12" y1="17" x2="12" y2="17" />
          </svg>
          Search help
        </button>
      </div>

      {helpOpen && <SearchHelpDialog onClose={closeHelp} />}
      {touring && <GuidedTour opener={helpButton} onEnd={endTour} />}

      {error && <div className="callout callout--warning">{error}</div>}
      {download.error && <div className="callout callout--warning">{download.error}</div>}

      <DisplayGrid
        caption={`${config.label} matching this search`}
        columns={columns}
        rows={rows}
        loading={loading}
        keywords={state.keywords}
        emptyMessage={search.isError ? '' : emptyMessage}
        sort={sortStateOf(state.sortBy)}
        filters={state.filters}
        narrowExtras={narrowExtras}
        template={inside ? 'list' : config.template}
        headerless={config.headerless}
        listRow={listRow}
        sortOptions={inside ? INSIDE_SORT_OPTIONS : undefined}
        body={insideBody}
        footer={!insidePrompt}
        page={state.currentPage}
        pageSize={state.pageSize}
        total={total}
        onSort={(key) => url.setSort(key, '+')}
        onSortPicked={(key, dir) => url.setSort(key, dir)}
        onFilterChange={(id: string, value: FilterValue) => url.setFilter(id, value)}
        onPageChange={url.setPage}
        onPageSizeChange={url.setPageSize}
        onDownload={(id) => void download.start(id)}
        advancedFields={advancedFields}
        toolbar={(panelFields) => (
          <GridToolbar
            noun={noun}
            page={state.currentPage}
            pageSize={state.pageSize}
            total={total}
            loading={search.data === undefined}
            narrowed={!!term || filterCount > 0}
            columns={config.columns}
            hiddenColumns={state.hiddenColumns}
            filterCount={panelFields.filter((field) => state.filters[field.id] != null).length}
            panelOpen={panelOpen}
            onToggleColumn={(key) =>
              url.setHiddenColumns(
                state.hiddenColumns.includes(key)
                  ? state.hiddenColumns.filter((hidden) => hidden !== key)
                  : [...state.hiddenColumns, key],
              )
            }
            onTogglePanel={() => setPanelOpen((open) => !open)}
          >
            {scopeShown && (
              <div className="unified-search__scope" data-tour="scope" role="group" aria-label="Search documents by">
                {SCOPE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`unified-search__scope-option${
                      option.value === state.scope ? ' unified-search__scope-option--on' : ''
                    }`}
                    aria-pressed={option.value === state.scope}
                    onClick={() => setScope(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          </GridToolbar>
        )}
        resetKey={fieldsKey}
        chips={<ChipRow chips={chips} onRemove={removeChip} onClearAll={clearAll} />}
        panel={(panelFields) => (
          <AdvancedFilters
            key={fieldsKey}
            fields={panelFields}
            values={state.filters}
            open={panelOpen}
            onChange={(id, value) => url.setFilter(id, value)}
          />
        )}
      />
    </div>
  );
}
