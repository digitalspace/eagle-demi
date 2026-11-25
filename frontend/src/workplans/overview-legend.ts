import { EXTRA_TIME_LABEL, PHASE_COLOUR, type ColourKey } from './chart-colours';
import type { MarkStyle } from './chart-types';

/** One piece of a legend swatch, drawn with the page's own classes in a 44 x 24 box. */
export interface LegendPart {
  cls: string;
  style?: MarkStyle;
  text?: string;
}

export interface LegendEntry {
  label: string;
  parts: LegendPart[];
}

export interface LegendGroup {
  title: string;
  note?: string;
  items: LegendEntry[];
}

const MK = 'wp-ov-mk';
const pc = (key: ColourKey): MarkStyle => ({ '--pc': PHASE_COLOUR[key] });
const box = (left: number, width: number, key?: ColourKey): MarkStyle => ({ left, top: 4, width, height: 16, ...(key ? pc(key) : {}) });
const bar = (key: ColourKey, cls = 'ph'): LegendPart[] => [{ cls: `${MK} ${cls}`, style: box(2, 28, key) }];
const decision = (cls: string): LegendPart[] => [{ cls: `${MK} ev dk ${cls}`.trim(), style: { left: 10, top: 6 } }];
const icon = (cls: string): LegendPart => ({ cls: `${MK} ev ${cls}`, style: { left: 11, top: 7 } });
const iconPair = (cls: string): LegendPart[] => [icon(cls), { cls: `${MK} ev ${cls} plan`, style: { left: 25, top: 7 } }];

/** The Overview legend: phase colours; bars, then other Acts; markers, then calendar lines. */
export const OVERVIEW_LEGEND: readonly (readonly LegendGroup[])[] = [
  [
    {
      title: 'Phase colours',
      items: [
        { label: 'Pre-EA', parts: bar('pre') },
        { label: 'Early Engagement (2018)', parts: bar('ee') },
        { label: 'Process Planning (2018), Pre-Application (1996, 2002)', parts: bar('pp') },
        { label: 'Readiness Decision (2018), Evaluation (1996, 2002)', parts: bar('ready') },
        { label: EXTRA_TIME_LABEL, parts: bar('extra') },
        { label: 'Application Review', parts: bar('rev') },
        { label: 'Effects Assessment (2018), Further Assessment (1996, 2002)', parts: bar('eff') },
        { label: 'EAC Decision (2018), Referral (1996, 2002)', parts: bar('dec') },
        { label: 'After certificate: amendment, extension, substantial start', parts: bar('amd') },
        { label: 'Proponent Time: the file is with the proponent', parts: bar('prop', 'ph pt') },
      ],
    },
  ],
  [
    {
      title: 'Bars',
      note: 'Anything that takes time. Overlapping work drops to the next free line below.',
      items: [
        { label: 'Current phase', parts: [{ cls: `${MK} ph cur`, style: box(2, 28) }] },
        { label: 'Planned: the same bar, fainter', parts: bar('rev', 'ph plan') },
        {
          label: 'Over its time limit: the part past the limit',
          parts: [
            { cls: `${MK} ph jr`, style: box(2, 16, 'rev') },
            { cls: `${MK} ph over jl`, style: box(18, 12, 'rev') },
          ],
        },
        {
          label: 'Suspended: on hold',
          parts: [
            { cls: `${MK} ph jr`, style: box(2, 10, 'rev') },
            { cls: `${MK} ph sus jl jr`, style: box(12, 10, 'rev') },
            { cls: `${MK} ph jl`, style: box(22, 8, 'rev') },
          ],
        },
        {
          label: 'No recorded start date',
          parts: [
            { cls: `${MK} lead jr`, style: box(2, 16, 'pp') },
            { cls: `${MK} ph jl`, style: box(18, 12, 'pp') },
          ],
        },
        {
          label: 'No recorded end date',
          parts: [
            { cls: `${MK} ph`, style: box(2, 20, 'rev') },
            { cls: `${MK} arrow`, style: { left: 22, top: 6 } },
          ],
        },
      ],
    },
    {
      title: 'Other Acts',
      items: [{ label: 'Go to this project under the earlier or later Act', parts: [{ cls: 'wp-ov-jump wp-ov-jump--key', text: 'Act ›' }] }],
    },
  ],
  [
    {
      title: 'Markers',
      note: "Single dates. Decisions are circles; an amendment's bar ends at its decision, so it gets a circle only if refused, withdrawn, overdue or one-day.",
      items: [
        { label: 'Decision, go: issued, granted or approved', parts: decision('go') },
        { label: 'Decision, refused or terminated', parts: decision('no') },
        { label: 'Decision, withdrawn', parts: decision('wd') },
        { label: 'Decision, other outcome or none recorded', parts: decision('') },
        { label: 'Planned decision', parts: decision('plan') },
        { label: 'Overdue decision: planned date passed', parts: decision('warn') },
        { label: 'Time limit extension (outline: planned)', parts: iconPair('tl') },
        { label: 'Moved to another Act (outline: planned)', parts: iconPair('mv') },
        { label: 'One-day work', parts: [icon('day')] },
        { label: 'Dates conflict', parts: [icon('conf')] },
        { label: 'Missing date: a phase with no recorded date', parts: [icon('note')] },
      ],
    },
    {
      title: 'Calendar lines',
      items: [
        { label: 'Today', parts: [{ cls: 'wp-ov-gl wp-ov-gl--today', style: { left: 15 } }] },
        { label: 'Act took effect', parts: [{ cls: 'wp-ov-gl wp-ov-gl--actin', style: { left: 15 } }] },
      ],
    },
  ],
];
