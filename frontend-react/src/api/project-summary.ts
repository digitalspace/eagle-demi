import { api } from './client';
import { trackException } from '../telemetry';

/**
 * A lookup field as the project record actually carries it: a bare Eagle `List` ObjectId, a
 * `{_id, name}` pair the Track backfill wrote, or the plain name. `resolveListLabel` takes all three.
 */
export type ListRef = string | { _id?: string; name?: string } | null;

/** One lookup field after resolution. Never an id unless `unresolved` says so. */
export interface ResolvedLabel {
  text: string;
  /** `text` is a raw id: the lookup landed and held no row for it. */
  unresolved: boolean;
  /** The lookup has not landed, so `text` is empty rather than an id shown and then swapped. */
  pending: boolean;
}

/** Several resolved labels rendered as one line, with the tooltip for any id still on show. */
export interface LabelLine {
  text: string;
  pending: boolean;
  /** Empty when everything resolved, so the `title` attribute can be dropped. */
  title: string;
  parts: ResolvedLabel[];
}

/** An Eagle ObjectId. Anything else in a lookup field is already the label. */
const OBJECT_ID = /^[0-9a-f]{24}$/i;

/** Said to a reader who is looking at an id, so the page never shows one without saying why. */
const UNRESOLVED_HINT = 'Not in the registry’s list of names: ';

/**
 * Rows to ask for in the one `List` read. There are about 250 and the page is staff-only, so this
 * fits in a single request — the API caps a page at 1000 and refuses over 100 anonymously.
 */
const LIST_PAGE_SIZE = 1000;

/** Said in place of a list the read could not deliver, so an outage never reads as an empty registry. */
export const PROJECT_LIST_ERROR = 'The project list could not be loaded. Reload the page to try again.';

/**
 * Turn one stored lookup value into a label.
 *
 * @param lists  id -> name, or null while the lookup is still in flight.
 */
export function resolveListLabel(value: ListRef | undefined, lists: Map<string, string> | null): ResolvedLabel {
  if (value === null || value === undefined) return { text: '', unresolved: false, pending: false };

  if (typeof value === 'object') {
    const name = (value.name || '').trim();
    if (name) return { text: name, unresolved: false, pending: false };
    return resolveListLabel(value._id ?? null, lists);
  }

  const text = String(value).trim();
  // Not an id, so it is the label already: mock fixtures, Track's own string columns and any
  // record the backfill resolved all land here untouched.
  if (!text || !OBJECT_ID.test(text)) return { text, unresolved: false, pending: false };

  // Withheld rather than shown and swapped a moment later — the id would flash on every load.
  if (!lists) return { text: '', unresolved: false, pending: true };

  const name = lists.get(text);
  return name
    ? { text: name, unresolved: false, pending: false }
    : { text, unresolved: true, pending: false };
}

/** Resolve several lookup values and render them as one line. */
export function joinLabels(
  values: (ListRef | undefined)[],
  lists: Map<string, string> | null,
  separator: string,
): LabelLine {
  const parts = values.map((value) => resolveListLabel(value, lists));
  const unresolved = parts.filter((part) => part.unresolved).map((part) => part.text);
  return {
    text: parts
      .map((part) => part.text)
      .filter(Boolean)
      .join(separator),
    pending: parts.some((part) => part.pending),
    title: unresolved.length ? UNRESOLVED_HINT + unresolved.join(', ') : '',
    parts,
  };
}

interface SearchRow {
  id?: string | number;
  _id?: string | number;
  name?: string;
}

interface SearchEnvelope {
  searchResults?: SearchRow[];
}

/**
 * Every Eagle `List` row as id -> name, in one request.
 *
 * The project record stores List ObjectIds in `currentPhaseName` and friends, so without this the
 * page renders ids. A failed read gives an empty table rather than a retry: ids then render with
 * the tooltip that explains them, which is a worse page than names but still the page.
 */
export async function fetchLists(): Promise<Map<string, string>> {
  try {
    const body = await api<SearchEnvelope[]>(`/search?dataset=List&pageSize=${LIST_PAGE_SIZE}`);
    const rows = body?.[0]?.searchResults || [];
    // A nameless row is dropped rather than mapped to '': an id with its "not in the list"
    // tooltip says more than a blank.
    return new Map(rows.filter((row) => row.name).map((row) => [String(row.id ?? row._id), String(row.name)]));
  } catch (err) {
    trackException(err, { lookup: 'List' });
    return new Map();
  }
}
