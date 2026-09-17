import type { GridColumn, ValueOption } from '../grid-types';
import {
  RECORD_DATASETS,
  projectPath,
  type RecordTypeConfig,
  type SearchMeta,
} from './record-type';

type Row = Record<string, unknown>;

/** Activities are dated with `dateAdded`, not the shared `datePosted` the other tabs sort by. */
export const ACTIVITIES_SORT = '-dateAdded';

/**
 * The index field behind "Documents attached". An index without it answers a query that names it
 * under `meta[0].dropped`.
 */
export const ATTACHMENTS_FILTER_ID = 'documentUrl';

/** Whether a response said the index carries no `documentUrl`, so the control can narrow nothing. */
export function attachmentsFilterDropped(meta?: SearchMeta[] | null): boolean {
  return !!meta?.[0]?.dropped?.includes(ATTACHMENTS_FILTER_ID);
}

/**
 * `RecentActivity.type` is free text, written from the fixed list the admin app offers, so the
 * filter offers those four and nothing else.
 */
const ACTIVITY_KINDS = [
  'News',
  'Project Notification News',
  'Project Notification Public Comment Period',
  'Public Comment Period',
];

const KIND_OPTIONS: ValueOption[] = ACTIVITY_KINDS.map((kind) => ({ value: kind, label: kind }));

/** The project an update belongs to: populated on some reads, a bare id on others. */
export function projectOf(row: Row): { id: string; name: string } {
  const project = row['project'];
  if (project && typeof project === 'object') {
    const held = project as { _id?: unknown; name?: unknown };
    return { id: String(held._id ?? ''), name: String(held.name ?? '') };
  }
  return { id: String(project ?? ''), name: '' };
}

/**
 * What the update is about. An update raised against a project notification rather than a project
 * carries the notification's name instead.
 */
export function subjectName(row: Row): string {
  const notification = row['projectNotification'];
  const held = notification && typeof notification === 'object' ? notification : {};
  return (
    projectOf(row).name ||
    String(row['notificationName'] ?? '') ||
    String((held as { name?: unknown }).name ?? '')
  );
}

function projectHref(row: Row): string | undefined {
  const { id } = projectOf(row);
  return id === '' ? undefined : projectPath(id);
}

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

/**
 * The update's body as words. `content` is stored as HTML, and the row clamps, excerpts and
 * highlights plain text, so the markup comes out here rather than being rendered and measured.
 */
export function plainText(value: unknown): string {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The posted date as the meta line sets it: numeric `YYYY-MM-DD`, the same form the date columns
 * carry. UTC, because the feed sends midnight dates and a local zone slides them into the previous
 * day.
 */
export function isoDay(value: unknown): string {
  const text = String(value ?? '');
  if (text === '') return '';
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-CA', { timeZone: 'UTC' });
}

/**
 * Columns are the record's fields rather than a layout here: a list row draws itself. They carry
 * the Kind filter, which the panel picks up because a list has no filter row to put it in.
 */
const COLUMNS: GridColumn<Row>[] = [
  { key: 'headline', label: 'Update', sortable: true, locked: true, width: '52%' },
  {
    key: 'dateAdded',
    label: 'Posted',
    sortable: true,
    date: true,
    primaryDate: true,
    width: '14%',
  },
  { key: 'type', label: 'Kind', filter: 'values', filterId: 'type', width: '16%' },
  {
    key: 'project',
    label: 'Project',
    link: true,
    href: projectHref,
    render: subjectName,
    width: '18%',
  },
];

/** Activities and updates, newest first. */
export const activitiesConfig: RecordTypeConfig = {
  id: 'activities',
  label: 'Activities & updates',
  noun: 'updates',
  dataset: RECORD_DATASETS.activities,
  defaultSort: ACTIVITIES_SORT,
  template: 'list',
  columns: COLUMNS,
  advancedFields: [
    { id: 'dateAddedStart', label: 'Posted from', kind: 'date', placeholder: 'YYYY-MM-DD' },
    { id: 'dateAddedEnd', label: 'Posted to', kind: 'date', placeholder: 'YYYY-MM-DD' },
    { id: ATTACHMENTS_FILTER_ID, label: 'Documents attached', kind: 'toggle' },
  ],
  optionsFrom: () => ({ type: KIND_OPTIONS }),
  selectable: false,
  headerless: false,
  rowTemplate: 'activity',
};
