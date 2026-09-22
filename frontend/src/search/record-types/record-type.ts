import type {
  AdvancedField,
  GridColumn,
  GridTemplate,
  RowTemplate,
  ValueOption,
} from '../grid-types';
import type { RecordType } from '../grid-url';

/**
 * The shape of one record type, split from `index.ts` so the per-type files can read it without
 * importing the registry that imports them back.
 */

/** The `record` URL value, which is also the registry key. */
export type RecordId = RecordType;

/** A `List` or `Organization` row as the option builders read one. Every field is optional. */
export interface OptionSource {
  _id?: string;
  code?: string;
  name?: string;
  type?: string;
  legislation?: number | string;
}

/** The search dataset name per record type. `search/counts` keys its answer by these. */
export const RECORD_DATASETS: Record<RecordId, string> = {
  projects: 'Project',
  documents: 'Document',
  activities: 'RecentActivity',
  notifications: 'ProjectNotification',
};

/** `meta[0]` of a search envelope. */
export interface SearchMeta {
  searchResultsTotal?: number;
}

export interface RecordTypeConfig<Row = Record<string, unknown>> {
  id: RecordId;
  label: string;
  /**
   * What a count or an empty line calls these records: "10 of 24 updates". The tab label is the
   * fallback, and reads as a heading rather than as a noun in a sentence for the types that set
   * this.
   */
  noun?: string;
  /** The `dataset=` value the search endpoint takes. */
  dataset: string;
  defaultSort: string;
  template: GridTemplate;
  columns: GridColumn<Row>[];
  /** The More filters panel, which carries the ids no column can show. */
  advancedFields: AdvancedField[];
  /** Dropdown values per filter id, built from the cached `List` and `Organization` reads. */
  optionsFrom: (lists: OptionSource[], orgs: OptionSource[]) => Record<string, ValueOption[]>;
  /** No column headings and no filter row: the column filters move into the panel. */
  headerless: boolean;
  /** Which row template a headerless type draws itself with. */
  rowTemplate?: RowTemplate;
}

/** An option's wire value is its `_id`, or its `code` for the lists that carry no id. */
export function toOptions(items: OptionSource[]): ValueOption[] {
  return items
    .map((item) => ({ value: item._id ?? item.code ?? item.name ?? '', label: item.name ?? '' }))
    .filter((option) => option.value !== '' && option.label !== '');
}

/**
 * Project type as the filter sends it. The index stores the label rather than a code, so the value
 * and the label are the same string.
 */
export const PROJECT_TYPES: OptionSource[] = [
  { code: 'Energy-Electricity', name: 'Energy-Electricity' },
  { code: 'Energy-Petroleum & Natural Gas', name: 'Energy-Petroleum & Natural Gas' },
  { code: 'Food Processing', name: 'Food Processing' },
  { code: 'Industrial', name: 'Industrial' },
  { code: 'Mines', name: 'Mines' },
  { code: 'Other', name: 'Other' },
  { code: 'Tourist Destination Resorts', name: 'Tourist Destination Resorts' },
  { code: 'Transportation', name: 'Transportation' },
  { code: 'Waste Disposal', name: 'Waste Disposal' },
  { code: 'Water Management', name: 'Water Management' },
];

export const REGIONS: OptionSource[] = [
  { code: 'Cariboo', name: 'Cariboo' },
  { code: 'Kootenay', name: 'Kootenay' },
  { code: 'Lower Mainland', name: 'Lower Mainland' },
  { code: 'Okanagan', name: 'Okanagan' },
  { code: 'Omineca', name: 'Omineca' },
  { code: 'Peace', name: 'Peace' },
  { code: 'Skeena', name: 'Skeena' },
  { code: 'Thompson-Nicola', name: 'Thompson-Nicola' },
  { code: 'Vancouver Island', name: 'Vancouver Island' },
];

export const PCP_STATES: OptionSource[] = [
  { code: 'none', name: 'None' },
  { code: 'pending', name: 'Upcoming' },
  { code: 'open', name: 'Open' },
  { code: 'closed', name: 'Closed' },
];

export const NOTIFICATION_DECISIONS: OptionSource[] = [
  { code: 'In Progress', name: 'In Progress' },
  { code: 'Referred for s.11 consideration', name: 'Referred for s.11 consideration' },
  { code: 'Not referred for s.11 consideration', name: 'Not referred for s.11 consideration' },
];

/** The project's own page in this app. */
export function projectPath(id: string): string {
  return `/projects/${encodeURIComponent(id)}`;
}
