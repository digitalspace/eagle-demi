import type { GridCell, GridColumn, ValueOption } from '../grid-types';
import {
  RECORD_DATASETS,
  toOptions,
  type OptionSource,
  type RecordTypeConfig,
} from './record-type';

export const DOCUMENTS_SORT = '-datePosted';

/** The `List` item `type` each document filter draws its options from. */
export const DOCUMENT_FILTER_LISTS: Record<string, string> = {
  milestone: 'label',
  documentAuthorType: 'author',
  type: 'doctype',
  projectPhase: 'projectPhase',
};

/**
 * The name cell. A download rather than a link: the file needs a presigned URL, which only the
 * page can ask for, so the cell carries the document id and the template wires the click.
 */
function documentCell(row: Record<string, unknown>): GridCell {
  const id = row['_id'];
  const text = String(row['displayName'] ?? '');
  return typeof id === 'string' && id !== ''
    ? { kind: 'download', text, documentId: id }
    : { kind: 'text', text };
}

const COLUMNS: GridColumn<Record<string, unknown>>[] = [
  {
    key: 'displayName',
    label: 'Name',
    sortable: true,
    // The search backend reads `nameContains` as a match on the document's own `displayName`.
    filter: 'text',
    filterId: 'nameContains',
    link: true,
    cell: documentCell,
    hrefExternal: true,
    locked: true,
    width: '28%',
  },
  {
    key: 'datePosted',
    label: 'Date posted',
    sortable: true,
    // One whole year, which the page turns into the range the index takes.
    filter: 'year',
    date: true,
    primaryDate: true,
    width: '13%',
  },
  { key: 'type', label: 'Document type', filter: 'values', filterId: 'type', width: '16%' },
  { key: 'milestone', label: 'Milestone', filter: 'values', filterId: 'milestone', width: '17%' },
  {
    key: 'projectPhase',
    label: 'Project phase',
    filter: 'values',
    filterId: 'projectPhase',
    width: '17%',
  },
  {
    key: 'documentAuthorType',
    label: 'Author',
    filter: 'values',
    filterId: 'documentAuthorType',
    width: '9%',
  },
];

/** The Acts the `List` collection spans, newest first, as the legislation filter offers them. */
function legislationOptions(lists: OptionSource[]): ValueOption[] {
  const years = new Set<string>();
  for (const item of lists) {
    if (item.legislation) years.add(String(item.legislation));
  }
  return [...years]
    .sort()
    .reverse()
    .map((year) => ({ value: year, label: `${year} Act` }));
}

/** All documents. */
export const documentsConfig: RecordTypeConfig = {
  id: 'documents',
  label: 'Documents',
  dataset: RECORD_DATASETS.documents,
  defaultSort: DOCUMENTS_SORT,
  template: 'grid',
  columns: COLUMNS,
  advancedFields: [
    { id: 'datePostedStart', label: 'Posted from', kind: 'date', placeholder: 'YYYY-MM-DD' },
    { id: 'datePostedEnd', label: 'Posted to', kind: 'date', placeholder: 'YYYY-MM-DD' },
    { id: 'legislation', label: 'Legislation', kind: 'select' },
    { id: 'isFeatured', label: 'Featured documents', kind: 'toggle' },
  ],
  optionsFrom: (lists: OptionSource[]) => {
    const options: Record<string, ValueOption[]> = { legislation: legislationOptions(lists) };
    for (const [id, listType] of Object.entries(DOCUMENT_FILTER_LISTS)) {
      options[id] = toOptions(lists.filter((item) => item.type === listType));
    }
    return options;
  },
  // Bulk download is out of scope for this page, so no row carries a selection checkbox.
  selectable: false,
  headerless: false,
};
