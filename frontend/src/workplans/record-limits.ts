import type { WorkplanMilestone, WorkplanPhase, WorkplanRow } from '../api/sheet-works';
import type { MarkStyle } from './chart-types';
import { colourOf, tint } from './chart-colours';
import { plainWords } from './chart-words';
import { count, plural } from './format';
import { dayNo, isoOf, milestoneDay } from './record-axis';
import {
  type ExtEvent,
  type ExtPlan,
  type LimitPart,
  type LimitPartView,
  type LimitRow,
  type LimitSum,
  type LimitTotal,
  type PhaseInfo,
  type RecordCtx,
  type RecordMark,
  type RecordRow,
  type StepRow,
  extOf,
  f3,
  markOf,
  susOf,
} from './record-types';

/** Smallest set of events, in pool order, whose days add up to the target; null when none does. */
export function pickSum<T extends { n: number }>(xs: readonly T[], t: number): T[] | null {
  let best: T[] | null = null;
  const got: T[] = [];
  const walk = (k: number, sum: number) => {
    if (sum === t) {
      if (!best || got.length < best.length) best = got.slice();
      return;
    }
    if (k >= xs.length || sum > t || (best && got.length >= best.length)) return;
    got.push(xs[k]);
    walk(k + 1, sum + xs[k].n);
    got.pop();
    walk(k + 1, sum);
  };
  walk(0, 0);
  return best;
}

// Track sends extension events per work, not per phase. Each phase with extensionDays takes the events whose days
// add up to it: inside the phase, then the gap after it, then the next phase, then the one before.
export function extPlan(w: WorkplanRow): ExtPlan {
  const phs = w.phases.slice().sort((x, y) => (x.order || 0) - (y.order || 0));
  const evs: ExtEvent[] = (w.milestones ?? [])
    .filter((m) => m.kind === 'extension')
    .map((m) => ({ m, d: milestoneDay(m), n: m.numberOfDays || 0, ph: null, counted: false }));
  const S = (ph: WorkplanPhase) => dayNo(ph.startDate);
  const E = (ph: WorkplanPhase) => dayNo(ph.endDate);
  const inside = (x: ExtEvent, ph: WorkplanPhase | undefined) => {
    if (!ph) return false;
    const s = S(ph);
    const e = E(ph);
    if (x.d == null || (s == null && e == null)) return false;
    return (s == null || x.d >= s) && (e == null || x.d <= e);
  };
  const gap = (x: ExtEvent, i: number) => {
    const e = E(phs[i]);
    const ns = phs[i + 1] ? S(phs[i + 1]) : null;
    return x.d != null && e != null && ns != null && x.d > e && x.d < ns;
  };
  const noDates = phs.map(() => 0);
  phs.forEach((ph, i) => {
    const t = ph.extensionDays || 0;
    if (t <= 0) return;
    const pools = [
      (x: ExtEvent) => inside(x, ph),
      (x: ExtEvent) => gap(x, i),
      (x: ExtEvent) => inside(x, phs[i + 1]),
      (x: ExtEvent) => i > 0 && inside(x, phs[i - 1]),
    ];
    let got: ExtEvent[] | null = null;
    for (let lv = 1; lv <= pools.length && !got; lv++) {
      const cands: ExtEvent[] = [];
      pools.slice(0, lv).forEach((f) =>
        evs.forEach((x) => {
          if (!x.ph && x.n > 0 && f(x) && !cands.includes(x)) cands.push(x);
        }),
      );
      got = pickSum(cands, t);
    }
    if (got)
      got.forEach((x) => {
        x.ph = ph;
        x.counted = true;
      });
    else noDates[i] = t;
  });
  // Left-overs: the phase the date falls in, else the phase that ended last before it, else the first phase; undated under the last phase.
  evs
    .filter((x) => !x.ph)
    .forEach((x) => {
      const d = x.d;
      if (d == null) {
        x.ph = phs.at(-1) ?? null;
        return;
      }
      const endedBefore = phs.filter((ph) => (E(ph) ?? Infinity) < d).sort((a, b) => (E(b) ?? 0) - (E(a) ?? 0));
      x.ph = phs.find((ph) => inside(x, ph)) ?? endedBefore[0] ?? phs[0] ?? null;
    });
  return { evs, noDates, phs };
}

/** One Track extension event as a mark and a row of the phase it belongs to; `markRow` takes the mark instead of `r`. */
export function addExt(r: LimitPart | undefined, x: ExtEvent, mid: string, ctx: RecordCtx, markRow?: { marks: RecordMark[] }) {
  if (!r) return;
  const m = x.m;
  const sec = plainWords((/s\.\s?\d+(\(\d+\))?/.exec(String(m.name)) ?? [''])[0]) || 'section not recorded';
  const planned = !m.actualDate && !!m.anticipatedDate;
  // Proposed rules: an extension's days count once it is granted, that is, once it has an actual date.
  const counted = x.counted && !planned;
  const when = x.d == null ? 'date not recorded' : `${planned ? 'planned ' : ''}${isoOf(x.d)}`;
  if (x.d != null) {
    ctx.used.add('xpt');
    const title = `Time limit extension${counted ? '' : planned ? ', planned, not yet granted' : ', not counted in the time limit'}`;
    const rows = [['Section', sec], ['Date', when], ['Length', `+${plural(x.n, 'day')}`], ['Phase', r.name]] as const;
    (markRow ?? r).marks.push(markOf('xpt', { top: '38px', left: `${f3(ctx.scale.pct(x.d))}%` }, title, rows, mid));
  }
  r.lrows.push({
    sort: x.d ?? 1e9,
    e: x.d,
    g: 'g xpt',
    cls: 'xpt',
    kind: 'Extension',
    section: sec,
    from: when,
    to: '',
    n: x.n,
    mid,
    pastTxt: '',
    note: counted ? '' : planned ? 'planned, not yet granted: not counted' : 'not counted in the time limit',
    isExt: true,
    counted,
  });
  if (counted) r.sumE += x.n;
}

/** The red "over a time limit" mark: the last `over` days of the phase. */
export function olimMark(o: PhaseInfo, ph: WorkplanPhase, ctx: RecordCtx): RecordMark {
  ctx.used.add('olim');
  const { pct } = ctx.scale;
  const olim = o.olim ?? { a: 0, b: 0, counted: 0, lim: 0 };
  // A short overrun is drawn 4 px wide ending at the phase end, so it stays inside its bar.
  const w = f3(Math.max(0, pct(olim.b) - pct(olim.a)));
  const style: MarkStyle = { left: `${f3(pct(olim.a))}%`, width: `max(4px, ${w}%)`, marginLeft: `min(0px, calc(${w}% - 4px))` };
  return markOf('olim', style, `Over by ${plural(o.over, 'day')}`, [
    ['Phase', ph.name],
    ['Days counted', String(olim.counted)],
    ['Time limit', `${plural(olim.lim, 'day')}${extOf(ph) ? ', with extensions' : ''}`],
    ['From', isoOf(olim.a)],
  ]);
}

/** Places a Track assessment's extension events on its step rows, and the totals no events add up to. */
export function placeExtensions(steps: StepRow[], w: WorkplanRow, ctx: RecordCtx, idOf: (m: WorkplanMilestone) => string | undefined) {
  const plan = extPlan(w);
  const rowOfPh = (ph: WorkplanPhase | null) => steps.find((r) => r.ph === ph);
  plan.evs.forEach((x, k) => addExt(rowOfPh(x.ph), x, idOf(x.m) ?? `xe${k}`, ctx));
  plan.phs.forEach((ph, i) => {
    const r = rowOfPh(ph);
    if (r && plan.noDates[i]) r.noDates = plan.noDates[i];
  });
  return plan;
}

const isCounted = (x: LimitRow) => x.isExt && x.counted !== false;

function totalsOf(r: LimitPart, sus: number) {
  const totals: Omit<LimitTotal, 'barCls' | 'barStyle'>[] = [];
  if (r.lrows.some(isCounted)) totals.push({ k: 'Extended, total', v: String(r.sumE), n: r.sumE, isExt: true });
  if (r.lrows.some((x) => !x.isExt)) totals.push({ k: 'Suspended, total', v: String(sus), n: sus, isExt: false });
  const left = r.lrows.filter((x) => x.counted === false).reduce((n, x) => n + x.n, 0);
  if (r.lrows.some((x) => x.counted === false))
    totals.push({ k: 'Not counted in the time limit, total', v: String(left), n: left, isExt: true });
  return totals;
}

export interface PartOptions {
  /** The work's `workTypeCode`, for the phase colour. */
  type: string | null;
  label: string;
  work: string;
}

// Phases without extension or suspension totals of their own take them from their change rows.
function addRowTotals(r: LimitPart, ph: WorkplanPhase) {
  if (extOf(ph) || susOf(ph) || !(r.sumE || r.sumS)) return;
  const t = [r.sumE ? `${plural(r.sumE, 'day')} extended` : '', r.sumS ? `${plural(r.sumS, 'day')} suspended` : '']
    .filter(Boolean)
    .join(', ');
  r.limText = r.limText ? `${r.limText}, ${t}` : t[0].toUpperCase() + t.slice(1);
}

interface PartDays {
  len: number;
  lim: number;
  counted: number;
  sus: number;
  ext: number;
}

/** The part's summary lines: time limit, days counted, extended, suspended, and how far over the limit when it is. */
function sumOf(r: LimitPart, ph: WorkplanPhase, { len, lim, counted, sus, ext }: PartDays, countedStyle: MarkStyle): LimitSum[] {
  const legal = !!ph.legislated && lim > 0;
  const sum: LimitSum[] = [
    { k: lim && !ph.legislated ? 'Planned length' : 'Time limit', v: lim ? plural(lim, 'day') : 'none recorded', cls: '', kg: lim ? 'sl' : 'none', kgStyle: {} },
    { k: 'Extended', v: plural(ext, 'day') + (r.noDates ? ', dates not recorded' : ''), cls: '', kg: 'se', kgStyle: {} },
  ];
  // The numbers the proposed rules give each legislated phase: time allowed, days taken, days left or overage, deadline.
  if (legal) sum.push({ k: 'Time allowed', v: plural(lim + ext, 'day'), cls: '', kg: 'none', kgStyle: {} });
  sum.push({ k: 'Suspended', v: plural(sus, 'day'), cls: '', kg: 'ss', kgStyle: {} });
  sum.push({ k: 'Days taken', v: plural(counted, 'day') + (sus ? ` of ${count(len)}` : ''), cls: '', kg: 'sc', kgStyle: countedStyle });
  const over = r.o?.over ?? 0;
  if (over > 0) sum.push({ k: 'Overage', v: plural(over, 'day'), cls: 'warn', kg: 'none', kgStyle: {} });
  else if (legal && len > 0) sum.push({ k: 'Days left', v: plural(Math.max(0, lim + ext - counted), 'day'), cls: '', kg: 'none', kgStyle: {} });
  if (legal && r.o?.deadline) sum.push({ k: 'Deadline', v: r.o.deadline, cls: '', kg: 'none', kgStyle: {} });
  return sum;
}

/** One phase's part of the Time limit changes block: heading, scale bar, summary, and its table with totals. */
export function addPart(r: LimitPart, opt: PartOptions): LimitPartView | null {
  const ph = r.ph;
  if (!ph) return null;
  r.lrows.sort((x, y) => x.sort - y.sort);
  addRowTotals(r, ph);
  const len = r.o?.run ?? (r.o?.len || 0);
  const sus = r.sumS;
  const ext = r.noDates || r.sumE;
  const lim = ph.numberOfDays || 0;
  const counted = Math.max(0, len - sus);
  const scale = Math.max(1, len, lim + ext);
  const pc = (v: number) => `${f3((v / scale) * 100)}%`;
  const c = colourOf(ph.name, opt.type);
  const countedStyle: MarkStyle = { background: tint(c, 0.35), borderColor: c };
  const bar: LimitPartView['bar'] = [{ cls: 'sc', style: { left: 0, width: pc(counted), ...countedStyle } }];
  if (sus) bar.push({ cls: 'ss', style: { left: pc(counted), width: pc(sus) } });
  if (ext) bar.push({ cls: 'se', style: { left: pc(lim), width: pc(ext) } });
  if (lim) bar.push({ cls: 'sl', style: { left: pc(lim) } });
  const sum = sumOf(r, ph, { len, lim, counted, sus, ext }, countedStyle);
  const bare = totalsOf(r, sus);
  // One scale per phase: rows and totals share it, up to 320 px.
  const dmax = Math.max(1, ...r.lrows.map((x) => x.n), ...bare.map((t) => t.n));
  const dbar = (x: { n: number; isExt: boolean }) => ({
    barCls: x.isExt ? ('ext' as const) : ('sus' as const),
    barStyle: { width: `${Math.max(3, Math.round((x.n / dmax) * 320))}px` },
  });
  return {
    id: `lim-${r.id}`,
    partId: `limp-${r.id}`,
    name: opt.label,
    sw: { background: c },
    bar,
    sum,
    totals: bare.map((t) => ({ ...t, ...dbar(t) })),
    work: opt.work,
    phase: ph.name ?? '',
    extDays: String(extOf(ph)),
    total: String(r.sumE),
    spans: r.lrows.some((x) => !!x.to && x.to !== x.from),
    onlyExt: r.lrows.every((x) => x.isExt),
    noDatesText: r.noDates ? `${plural(r.noDates, 'day')} extended, dates not recorded` : '',
    rows: r.lrows.map((x) => ({
      g: x.g,
      kind: x.kind,
      warn: x.pastTxt,
      note: x.note,
      section: x.section,
      from: x.from,
      // A Track extension is recorded on one date: To only for a change that spans dates, such as a suspension.
      to: x.to && x.to !== x.from ? x.to : '',
      days: String(x.n),
      counted: x.counted === false ? 'false' : 'true',
      ...dbar(x),
      mid: x.mid,
    })),
  };
}

/** Sets the "N changes" link on a row label to its part in the Time limit changes block. */
export function linkTo(r: Pick<RecordRow, 'chg'>, headId: string, n: number, name: string) {
  const text = plural(n, 'change');
  r.chg = { text, label: `${text} to the time limit of ${name}, in Time limit changes`, href: `#${headId}`, headId };
}

/** The "N changes" link's action: scroll to its part and move focus there. */
export function jumpToPart(from: Element | null, headId: string) {
  const root = from?.closest('.wp-rec') ?? null;
  const h = root?.querySelector<HTMLElement>(`#${headId}`) ?? null;
  if (!h) return;
  // The block title stays in view above the heading whenever both fit in the window.
  const sec = h.closest('section');
  const keepTitle = sec && h.getBoundingClientRect().top - sec.getBoundingClientRect().top < window.innerHeight * 0.6;
  (keepTitle ? sec : h).scrollIntoView({ block: 'start' });
  h.focus({ preventScroll: true });
}

/** The assessment's parts of the Time limit changes block, one per step with changes, each linked from its row. */
export function assessmentParts(steps: StepRow[], w: WorkplanRow): LimitPartView[] {
  return steps
    .filter((r) => r.lrows.length || r.noDates)
    .flatMap((r) => {
      const part = addPart(r, { type: w.workTypeCode, label: r.name, work: w.workId });
      if (!part) return [];
      linkTo(r, part.id, r.lrows.length, r.name);
      return [part];
    });
}
