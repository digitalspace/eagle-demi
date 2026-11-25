import { KIND_GROUPS, KINDS, legendOf, type KindId, type KindItem } from './chart-kinds';

/** The All marks panel: every phase colour and every kind the Record page can draw. */
export const RECORD_ALL_MARKS = legendOf();

// Decision, move and today lines carry their own axis label, so the key leaves them out.
const AXIS_LABELLED: ReadonlySet<KindId> = new Set(['dec', 'move', 'today']);
const KEY_ORDER = KIND_GROUPS.flatMap((g) => g.kinds).filter((id) => !AXIS_LABELLED.has(id));

/** The legend of one record: the kinds it drew, in legend order. */
export const recordLegend = (used: ReadonlySet<KindId>): KindItem[] =>
  KEY_ORDER.flatMap((id) => (used.has(id) ? [{ label: KINDS[id].label, parts: KINDS[id].rec }] : []));
