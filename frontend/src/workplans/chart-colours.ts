// Both screens import this module, so the shared mark look loads with the phase colours.
import './chart-marks.css';

// Track's template colours, from the eagle tokens: Track data, not a theme choice.
export const PHASE_COLOUR = {
  pre: 'var(--eao-pre-eac-dark)',
  ee: 'var(--eao-early-engagement-dark)',
  pp: 'var(--eao-process-planning-dark)',
  ready: 'var(--eao-readiness-decision-dark)',
  // Not a Track phase: Evaluation's colour darkened, so it stays apart from Evaluation and its planned tint.
  extra: 'color-mix(in srgb, var(--eao-readiness-decision-dark) 70%, var(--theme-gray-110))',
  rev: 'var(--eao-application-development-dark)',
  eff: 'var(--eao-effects-assessment-dark)',
  dec: 'var(--eao-decision-dark)',
  prop: 'var(--eao-proponent-dark)',
  amd: 'var(--eao-amendment-dark)',
} as const;

export type ColourKey = keyof typeof PHASE_COLOUR;

// 1996 and 2002 phases take the colour of the matching 2018 phase.
const KEY_BY_NAME: Record<string, ColourKey> = {
  'Pre-EA': 'pre',
  'Pre-EA (EAC Assessment)': 'pre',
  'Early Engagement': 'ee',
  'Pre-Application': 'pp',
  'Process Planning': 'pp',
  Evaluation: 'ready',
  'Extra Time': 'extra',
  'Readiness Decision': 'ready',
  'Further Readiness Decision': 'ready',
  'Application Review': 'rev',
  'EAC Application Review': 'rev',
  'Further Assessment': 'eff',
  'Effects Assessment & Recommendation': 'eff',
  Referral: 'dec',
  'EAC Decision': 'dec',
};

const AFTER_CERTIFICATE = new Set(['amendment', 'eac-extension', 'substantial-start']);

/** The colour key of a phase, by its name and its work's `workTypeCode`. */
export function colourKeyOf(name: string | null, workType: string | null): ColourKey {
  const phase = name ?? '';
  if (/Proponent Time/.test(phase)) return 'prop';
  const known = KEY_BY_NAME[phase];
  if (known) return known;
  if (/^Post Decision/.test(phase) || AFTER_CERTIFICATE.has(workType ?? '')) return 'amd';
  if (/Decision/.test(phase)) return 'dec';
  if (/Review/.test(phase)) return 'rev';
  if (/Intake|Pre-/.test(phase)) return 'pre';
  return 'ee';
}

/** The phase colour as a CSS variable, the same on both pages. */
export const colourOf = (name: string | null, workType: string | null) => PHASE_COLOUR[colourKeyOf(name, workType)];

/** The colour at `share` (0 to 1) over transparent. */
export const tint = (colour: string, share: number) =>
  `color-mix(in srgb, ${colour} ${Math.round(share * 100)}%, transparent)`;

/** The Extra Time legend label, the same in both legends. */
export const EXTRA_TIME_LABEL = 'Extra Time (1996, 2002), not a Track phase: from Start Extra to the next phase, no time limit';

/** Each phase colour once, in process order, with the phase names it stands for under each Act. */
export const PHASE_KEY: readonly { key: ColourKey; label: string }[] = [
  { key: 'pre', label: 'Pre-EA' },
  { key: 'ee', label: 'Early Engagement (2018)' },
  { key: 'pp', label: 'Process Planning (2018), Pre-Application (1996, 2002)' },
  { key: 'ready', label: 'Readiness Decision (2018), Evaluation (1996, 2002)' },
  { key: 'extra', label: EXTRA_TIME_LABEL },
  { key: 'rev', label: 'Application Review' },
  { key: 'eff', label: 'Effects Assessment (2018), Further Assessment (1996, 2002)' },
  { key: 'dec', label: 'EAC Decision (2018), Referral (1996, 2002)' },
  { key: 'prop', label: 'Proponent Time' },
  { key: 'amd', label: 'After certificate: amendment, extension, substantial start' },
];
