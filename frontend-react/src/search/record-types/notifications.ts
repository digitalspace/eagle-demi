import type { GridColumn } from '../grid-types';
import {
  NOTIFICATION_DECISIONS,
  PCP_STATES,
  PROJECT_TYPES,
  RECORD_DATASETS,
  REGIONS,
  projectPath,
  toOptions,
  type RecordTypeConfig,
} from './record-type';

/** Newest record first, by insertion order. */
export const NOTIFICATIONS_SORT = '-_id';

/** The project the notification became. */
function projectHref(row: Record<string, unknown>): string | undefined {
  const id = row['associatedProjectId'];
  return typeof id === 'string' && id !== '' ? projectPath(id) : undefined;
}

/**
 * A notification renders as one card, so these are its filterable fields rather than a layout.
 * A headerless grid has no filter row, so every one of them reaches the reader through the panel.
 */
const COLUMNS: GridColumn<Record<string, unknown>>[] = [
  { key: 'name', label: 'Project notification', link: true, href: projectHref, locked: true },
  { key: 'type', label: 'Project type', filter: 'values', filterId: 'type' },
  { key: 'region', label: 'Region', filter: 'values', filterId: 'region' },
  { key: 'pcp', label: 'Public comment period', filter: 'values', filterId: 'pcp' },
  { key: 'decision', label: 'Notification decision', filter: 'values', filterId: 'decision' },
];

/** Project notifications. */
export const notificationsConfig: RecordTypeConfig = {
  id: 'notifications',
  label: 'Project notifications',
  noun: 'notifications',
  dataset: RECORD_DATASETS.notifications,
  defaultSort: NOTIFICATIONS_SORT,
  template: 'list',
  columns: COLUMNS,
  advancedFields: [],
  // Every option is a constant, so these filters never wait on a request.
  optionsFrom: () => ({
    type: toOptions(PROJECT_TYPES),
    region: toOptions(REGIONS),
    pcp: toOptions(PCP_STATES),
    decision: toOptions(NOTIFICATION_DECISIONS),
  }),
  selectable: false,
  headerless: true,
  rowTemplate: 'notification',
};
