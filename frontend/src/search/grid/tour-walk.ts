import type { TourStep } from './tour-steps';

/**
 * Where the walk lands when the control it was on has gone: the first control after it that is
 * still on the page, so the gone control hands its slot on rather than the walk starting over.
 */
export function landingAfter(was: readonly TourStep[], gone: string | null, left: TourStep[]): number {
  const goneAt = was.findIndex((one) => one.target === gone);
  for (let at = goneAt + 1; at < was.length; at += 1) {
    const found = left.findIndex((one) => one.target === was[at].target);
    if (found >= 0) return found;
  }
  return left.length - 1;
}
