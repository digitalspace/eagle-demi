import { type ColourKey, PHASE_COLOUR, PHASE_KEY } from './chart-colours';
import type { MarkStyle } from './chart-types';

/** One piece of a key swatch: a mark drawn small with the classes of the real one (chart-marks.css). */
export interface SwatchPart {
  cls: string;
  style: MarkStyle;
}

/** One legend entry; `rec` is drawn with Record classes in a 32 x 20 box. */
export interface LegendItem {
  label: string;
  rec: SwatchPart[];
}

const part = (cls: string, style: MarkStyle): SwatchPart => ({ cls, style });
const pc = (key: ColourKey): MarkStyle => ({ '--pc': PHASE_COLOUR[key] });

const REC_BAR: MarkStyle = { left: 0, width: '32px' };
const REC_THIN: MarkStyle = { top: '5px', height: '10px' };
const AT_16: MarkStyle = { left: '16px' };
const DOT: MarkStyle = { top: '5px', left: '16px' };
const TICK: MarkStyle = { left: '15px' };

// Later works take the colour of their own phases, so their swatch shows three.
const ANY: readonly ColourKey[] = ['pp', 'rev', 'amd'];

const recPair = (ghostWidth: number, barLeft: number) => [
  part('bar ghostbar', { top: 0, height: '8px', left: 0, width: `${ghostWidth}px` }),
  part('bar', { top: '12px', height: '8px', left: `${barLeft}px`, width: `${32 - barLeft}px`, ...pc('rev') }),
];

const DEFS = {
  step: { label: 'Phase with recorded dates', rec: [part('bar', { ...REC_BAR, ...pc('rev') })] },
  planned: {
    label: 'Planned phase or part of a phase',
    rec: [part('bar planned', { ...REC_BAR, ...pc('rev') })],
  },
  cur: { label: 'Current phase', rec: [part('bar cur', REC_BAR)] },
  later: {
    label: 'Later work: amendment or extension, any phase colour',
    rec: ANY.map((key, i) => part('bar thin', { ...REC_THIN, left: `${i * 11}px`, width: '10px', ...pc(key) })),
  },
  laterPlan: {
    label: 'Planned later work',
    rec: [part('bar planned thin', { ...REC_THIN, ...REC_BAR, ...pc('amd') })],
  },
  point: {
    label: 'One day or zero length',
    rec: [part('bar point', { top: '4.5px', left: '16px', ...pc('rev') })],
  },
  cut: { label: 'Continues past the chart edge', rec: [part('bar cutR', { ...REC_BAR, ...pc('rev') })] },

  evDec: { label: 'Decision', rec: [part('dflag', AT_16)] },
  decPlan: { label: 'Planned decision', rec: [part('dflag plan', AT_16)] },
  msPassed: {
    label: 'Planned date passed',
    // Record draws the "!" head on a decision stem, and alone for a milestone.
    rec: [part('dflag due', { left: '3px' }), part('msdue', { top: '3px', left: '25px' })],
  },
  ms: { label: 'Milestone', rec: [part('dia', DOT)] },
  msPlan: { label: 'Planned milestone', rec: [part('dia planned', DOT)] },
  oth: { label: 'Other event', rec: [part('ring', DOT)] },
  cp: { label: 'Comment period', rec: [part('cp', { top: '3px', left: '4px', width: '24px' })] },
  dec: { label: 'Decision or certificate line', rec: [part('tick dec', TICK)] },
  today: { label: 'Today', rec: [part('tick today', TICK)] },

  sus: { label: 'Time limit suspended', rec: [part('int suspension', { top: '7px', ...REC_BAR })] },
  ext: {
    label: 'Time limit extended',
    rec: [part('int extension', { top: '7px', left: 0, width: '15px' }), part('int extension', { top: '7px', left: '17px', width: '15px' })],
  },
  xpt: { label: 'Time limit extended on one date', rec: [part('xpt', { top: '5px', left: '16px' })] },
  olim: { label: 'Over a time limit', rec: [part('olim', { top: '6px', left: '4px', width: '24px' })] },

  openStart: {
    label: 'No recorded start date',
    rec: [part('bar openStart', { ...REC_BAR, ...pc('rev') })],
  },
  openEnd: {
    label: 'No recorded end date',
    rec: [part('bar openEnd', { left: 0, width: '24px', ...pc('rev') })],
  },
  reversed: { label: 'Dates conflict: ends before it starts', rec: [part('bar reversed', AT_16)] },
  past: {
    label: 'Dates conflict: runs past its phase end',
    rec: [
      part('bar', { top: 0, height: '10px', left: 0, width: '18px', ...pc('rev') }),
      part('int extension', { top: '13px', left: '8px', width: '10px' }),
      part('int past', { top: '12px', left: '18px', width: '14px' }),
    ],
  },

  nextAct: {
    label: 'Assessment under another Act',
    rec: [part('bar ghostbar', REC_BAR)],
  },
  move: { label: 'Move between Acts', rec: [part('tick move', TICK)] },
  moveSame: { label: 'Move between Acts on the same day', rec: recPair(16, 16) },
  moveGap: { label: 'Move between Acts with a gap', rec: recPair(12, 20) },
  moveOver: { label: 'Move between Acts with an overlap', rec: recPair(20, 12) },
} satisfies Record<string, LegendItem>;

/** Every kind of mark the Record page draws. */
export type KindId = keyof typeof DEFS;

export const KINDS: Readonly<Record<KindId, LegendItem>> = DEFS;

/** Kinds by legend group, in legend order. */
export const KIND_GROUPS: readonly { title: string; kinds: readonly KindId[] }[] = [
  { title: 'Bars', kinds: ['step', 'planned', 'cur', 'later', 'laterPlan', 'point', 'cut'] },
  { title: 'Dates and decisions', kinds: ['evDec', 'decPlan', 'msPassed', 'ms', 'msPlan', 'oth', 'cp', 'dec', 'today'] },
  { title: 'Time limits', kinds: ['sus', 'ext', 'xpt', 'olim'] },
  { title: 'Data gaps and conflicts', kinds: ['openStart', 'openEnd', 'reversed', 'past'] },
  { title: 'Other Acts', kinds: ['nextAct', 'move', 'moveSame', 'moveGap', 'moveOver'] },
];

// The after-certificate colour is only ever drawn as a later work's thin bar.
const colourItem = ({ key, label }: (typeof PHASE_KEY)[number]): LegendItem =>
  key === 'amd'
    ? { label, rec: [part('bar thin', { ...REC_THIN, ...REC_BAR, ...pc(key) })] }
    : { label, rec: [part('bar', { ...REC_BAR, ...pc(key) })] };

const LEGEND: readonly { title: string; items: readonly LegendItem[] }[] = [
  { title: 'Phase colours, from Track', items: PHASE_KEY.map(colourItem) },
  ...KIND_GROUPS.map((g) => ({ title: g.title, items: g.kinds.map((id) => KINDS[id]) })),
];

/** A legend entry with its swatch. */
export interface KindItem {
  label: string;
  parts: SwatchPart[];
}

/** The Record legend, in legend order. */
export const legendOf = (): { title: string; items: KindItem[] }[] =>
  LEGEND.map((g) => ({ title: g.title, items: g.items.map((item) => ({ label: item.label, parts: item.rec })) }));
