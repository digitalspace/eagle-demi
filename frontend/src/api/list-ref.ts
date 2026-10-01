/**
 * An Eagle ObjectId. Seeded rows reuse it as their DEMI id, so it is also what says a document
 * exists on the public EPIC site; a DEMI-native upload carries a uuid and exists nowhere else.
 */
export const EAGLE_OBJECT_ID = /^[0-9a-f]{24}$/i;

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
  if (!text || !EAGLE_OBJECT_ID.test(text)) return { text, unresolved: false, pending: false };

  // Withheld rather than shown and swapped a moment later — the id would flash on every load.
  if (!lists) return { text: '', unresolved: false, pending: true };

  const name = lists.get(text);
  return name
    ? { text: name, unresolved: false, pending: false }
    : { text, unresolved: true, pending: false };
}
