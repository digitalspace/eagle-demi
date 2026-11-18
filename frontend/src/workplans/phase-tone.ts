import type { WorkplanPhase } from '../api/sheet-works';

/** Fill and edge pair of a phase; `review` is the design's green "general" pair. */
export type PhaseTone = 'review' | 'proponent' | 'planning' | 'readiness' | 'decision';

const PROPONENT = /proponent|^application development$|^dpd development/;
const DECISION = /decision$|^recommendation|^referral/;
const PLANNING = /^pre-ea|planning/;

/** By phase name, as the design's phase templates colour them; an unnamed phase goes by its stage. */
export function phaseToneOf(phase: Pick<WorkplanPhase, 'name' | 'stage'>): PhaseTone {
  const name = (phase.name || phase.stage || '').trim().toLowerCase();
  // Readiness Decision ends in "decision" but has its own pair.
  if (name.includes('readiness')) return 'readiness';
  if (PROPONENT.test(name)) return 'proponent';
  if (DECISION.test(name)) return 'decision';
  return PLANNING.test(name) ? 'planning' : 'review';
}
