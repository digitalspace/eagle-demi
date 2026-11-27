import type { MarkStyle } from './chart-types';
import { PHASE_COLOUR } from './chart-colours';
import { ago } from './chart-words';
import { count, plural } from './format';
import type { RecordEvent } from './record-events';
import type { EventCat } from './record-types';

/** Everything the Events block lists for one record. */
export interface RecordEvents {
  /** The assessment's events. */
  items: RecordEvent[];
  /** One entry per later work and per planned decision of one. */
  later: RecordEvent[];
  hasAssessment: boolean;
  laterWorks: number;
  /** The later works hang from a certificate: their group reads "After the certificate", else "Later works". */
  hasCert: boolean;
}

export const EVENT_CATS: readonly EventCat[] = ['dec', 'cp', 'sub', 'ms', 'oth'];

const totalOf = (xs: readonly RecordEvent[]) => xs.reduce((n, x) => n + x.count, 0);

/** The filter a record opens on: decisions and milestones over 15 events, else all. */
export const defaultEventSel = (ev: RecordEvents): EventCat[] => (totalOf(ev.items) > 15 ? ['dec', 'ms'] : [...EVENT_CATS]);

export interface EventChip {
  label: string;
  count: number;
  /** The filter this chip sets. */
  cats: EventCat[];
  pressed: boolean;
}

export interface EventEntry {
  id: string;
  /** `dec` on a decision; the caller adds highlight and selection. */
  cls: string;
  g: string;
  date: string;
  /** "to <day>", or ''. */
  dateEnd: string;
  name: string;
  /** "3 entries" for merged repeats, else ''. */
  countText: string;
  len: string;
  gap: string;
  gapStyle: MarkStyle;
  /** Accessible name; starts with the entry's kind. */
  label: string;
  hasMark: boolean;
  /** "Planned" or "Date passed" for an anticipated date, else ''. */
  tag: string;
  /** The phase the entry falls in, for the Phase column; null for comment periods and entries outside the phases. */
  phase: { name: string; sw: MarkStyle; swCls: string } | null;
}

export interface EventGroup {
  key: string;
  id: string;
  listId: string;
  name: string;
  sw: MarkStyle;
  /** Mark classes the swatch draws with, as on the chart; '' for a plain colour swatch. */
  swCls: string;
  /** Phase colour of the swatch and the entries' glyphs; '' when they have none. */
  colour: string;
  items: EventEntry[];
  /** "N hidden", beside the heading, when the filter hides every entry; the heading stays. */
  hiddenText: string;
  /** The later works' "Show all N" or "Show the 5 newest" control; null for other groups and up to 5 works. */
  more: { text: string; expanded: boolean } | null;
}

export interface EventListView {
  has: boolean;
  hasChips: boolean;
  chips: EventChip[];
  groups: EventGroup[];
  /** The assessment's entries under the filter as one list in date order, undated last. */
  rows: EventEntry[];
  /** The later works' own list; null when there are none. */
  after: EventGroup | null;
  hasMore: boolean;
  moreText: string;
  hasXpt: boolean;
  countText: string;
}

type GroupHead = Pick<EventGroup, 'key' | 'name' | 'sw' | 'swCls' | 'colour'>;

function groupOf(x: RecordEvent, hasCert: boolean): GroupHead {
  const head = (key: string, name: string, swCls: string, colour = ''): GroupHead => ({ key, name, sw: {}, swCls, colour });
  if (x.c === 'cp') return head('cp', 'Public comment periods', 'cp');
  if (x.step) return { key: x.step.id || x.step.name, name: x.step.name, sw: x.step.sw, swCls: x.step.glyph, colour: '' };
  if (x.c === 'aw') return head('after', hasCert ? 'After the certificate' : 'Later works', 'bar thin', PHASE_COLOUR.amd);
  if (x.d == null) return head('nodate', 'No recorded date', 'miss');
  return head('out', 'Outside the dated phases', 'none');
}

interface Bucket extends GroupHead {
  all: RecordEvent[];
  shown: RecordEvent[];
}

// Every group keeps its heading when the filter hides all its entries, so the groups match the chart's rows.
function bucketsOf(ev: RecordEvents, shown: Set<RecordEvent>): Bucket[] {
  const out: Bucket[] = [];
  for (const x of [...ev.items, ...ev.later]) {
    const head = groupOf(x, ev.hasCert);
    let b = out.find((y) => y.key === head.key);
    if (!b) {
      b = { ...head, all: [], shown: [] };
      out.push(b);
    }
    b.all.push(x);
    if (shown.has(x)) b.shown.push(x);
  }
  const byDay = (x: RecordEvent, y: RecordEvent) => (x.d ?? 1e9) - (y.d ?? 1e9);
  out.find((b) => b.key === 'after')?.shown.sort(byDay);
  const order = (b: Bucket) => ({ cp: 1e9, after: 1.5e9, nodate: 2e9 })[b.key] ?? (b.all[0].d || 0);
  return out.sort((x, y) => order(x) - order(y));
}

// Gaps run along the phases in date order; comment periods and later works each count from their own previous entry.
function gapsOf(buckets: readonly Bucket[]): Map<RecordEvent, number | null> {
  const gaps = new Map<RecordEvent, number | null>();
  const prev: Record<string, number | null> = { step: null, cp: null, aw: null };
  for (const x of buckets.flatMap((b) => b.shown)) {
    const k = x.c === 'cp' || x.c === 'aw' ? x.c : 'step';
    const before = prev[k];
    gaps.set(x, x.d != null && before != null ? x.d - before : null);
    if (x.d != null) prev[k] = x.d;
  }
  return gaps;
}

function entryOf(x: RecordEvent, gapN: number | null, maxGap: number): EventEntry {
  const gap = gapN == null ? '' : ago(gapN);
  // "2025-12-13, planned, date passed": the day or range, then what the tag says.
  const [when, ...said] = x.date.split(', ');
  const [date, end] = when.split(' to ');
  const tag = said.includes('date passed') ? 'Date passed' : said.includes('planned') ? 'Planned' : '';
  const phase = x.step && x.c !== 'cp' && x.c !== 'aw' ? { name: x.step.name, sw: x.step.sw, swCls: x.step.glyph } : null;
  const countText = x.count > 1 ? plural(x.count, 'entry', 'entries') : '';
  const label = [x.kind, x.date, x.name, countText, x.len, phase ? `in ${phase.name}` : '', gap].filter(Boolean).join(', ');
  return {
    id: x.id,
    cls: x.c === 'dec' ? 'dec' : '',
    g: x.g,
    date,
    dateEnd: end ? `to ${end}` : '',
    name: x.name,
    countText,
    len: x.len,
    gap,
    gapStyle: { width: `${gapN ? Math.max(3, Math.round((gapN / maxGap) * 140)) : 0}px` },
    label: label + (x.hasMark ? '' : '. Not drawn on the timeline.'),
    hasMark: x.hasMark,
    tag,
    phase,
  };
}

/** The Events block under a filter; `awAll` shows every later work instead of the 5 newest. */
export function eventList(ev: RecordEvents, sel: readonly EventCat[], awAll: boolean): EventListView {
  const total = totalOf(ev.items);
  const isAll = EVENT_CATS.every((c) => sel.includes(c));
  const cnt = (c: EventCat) => totalOf(ev.items.filter((x) => x.c === c));
  const chip = (label: string, cats: EventCat[], n: number, pressed: boolean): EventChip => ({ label, count: n, cats, pressed });
  const has = (c: EventCat) => !isAll && sel.includes(c);
  const chips = [
    chip('All', [...EVENT_CATS], total, isAll),
    chip('Decisions', ['dec'], cnt('dec'), has('dec')),
    chip('Comment periods', ['cp'], cnt('cp'), has('cp')),
    chip('Milestones', ['ms'], cnt('ms'), has('ms')),
    // Only where the record has any: sheet works carry no submission events.
    ...(cnt('sub') ? [chip('Submissions', ['sub'], cnt('sub'), has('sub'))] : []),
  ];
  const picked = ev.items.filter((x) => sel.includes(x.c));
  const shownCount = totalOf(picked);
  const buckets = bucketsOf(ev, new Set([...picked, ...ev.later]));
  const gaps = gapsOf(buckets);
  const maxGap = Math.max(1, ...[...gaps.values()].map((n) => n ?? 0));
  const groups = buckets.map((b): EventGroup => {
    const id = `evg-${b.key.replace(/[^a-z0-9]/gi, '')}`;
    const n = b.shown.length;
    const many = b.key === 'after' && n > 5;
    const items = many && !awAll ? b.shown.slice(-5) : b.shown;
    const more = many ? { text: awAll ? 'Show the 5 newest' : `Show all ${count(n)}`, expanded: awAll } : null;
    const hiddenText = n ? '' : `${count(totalOf(b.all))} hidden`;
    return { key: b.key, id, listId: `${id}-list`, name: b.name, sw: b.sw, swCls: b.swCls, colour: b.colour, items: items.map((x) => entryOf(x, gaps.get(x) ?? null, maxGap)), hiddenText, more };
  });
  const byDay = (x: RecordEvent, y: RecordEvent) => (x.d ?? 1e9) - (y.d ?? 1e9);
  const rows = [...picked].sort(byDay).map((x) => entryOf(x, null, 1));
  const after = groups.find((g) => g.key === 'after') ?? null;
  const merged = ev.items.length < total ? `, ${count(ev.items.length)} entries after merging repeats` : '';
  const shown = isAll ? `${plural(total, 'event')}${merged}` : `Showing ${count(shownCount)} of ${count(total)} events`;
  const later = ev.laterWorks ? `, ${plural(ev.laterWorks, 'later work')}` : '';
  return {
    has: ev.hasAssessment || ev.later.length > 0,
    hasChips: ev.hasAssessment,
    chips,
    groups,
    rows,
    after,
    hasMore: !isAll && total > shownCount,
    moreText: `Show all ${count(total)} events`,
    hasXpt: ev.items.some((x) => x.g === 'g xpt'),
    countText: `Select an entry to highlight its mark on the timeline. ${shown}${later}.`,
  };
}
