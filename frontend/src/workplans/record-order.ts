import type { WorkplanPhase } from '../api/sheet-works';
import { plural } from './format';
import { dayNo } from './record-axis';
import { type RecordCtx, addNote } from './record-types';

/**
 * Steps in the order they happened: by start date (end date when there is no start). A step with no date keeps its
 * place after the dated step before it, so "Not in this work" rows stay where the process puts them.
 */
export function chronological<T extends { ph: WorkplanPhase | undefined }>(steps: readonly T[]): T[] {
  let last = -Infinity;
  const keyed = steps.map((step, i) => {
    const d = dayNo(step.ph?.startDate) ?? dayNo(step.ph?.endDate);
    if (d != null) last = d;
    return { step, i, k: d ?? last, dated: d != null };
  });
  return keyed
    .sort((a, b) => a.k - b.k || (a.dated === b.dated ? a.i - b.i : a.dated ? -1 : 1))
    .map((x) => x.step);
}

/** Proposed rules: phases follow each other with exactly 0 days between them. Notes each pair of dated steps that breaks it. */
export function noteGaps(steps: readonly { ph: WorkplanPhase | undefined }[], ctx: RecordCtx): void {
  const dated = steps.flatMap((x) => (x.ph && dayNo(x.ph.startDate) != null && dayNo(x.ph.endDate) != null ? [x.ph] : []));
  dated.slice(1).forEach((ph, i) => {
    const gap = (dayNo(ph.startDate) ?? 0) - (dayNo(dated[i].endDate) ?? 0) - 1;
    if (gap > 0) addNote(ctx, 'warn', `Dates conflict: ${plural(gap, 'day')} between ${dated[i].name} and ${ph.name}; phases should follow with no gap`);
    // A shared boundary day is how Track stores phases today; more than that is an overlap.
    else if (gap < -1) addNote(ctx, 'warn', `Dates conflict: ${ph.name} starts ${plural(-gap - 1, 'day')} before ${dated[i].name} ends`);
  });
}
