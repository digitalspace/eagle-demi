import type { WorkplanRow } from '../api/sheet-works';

/** Who the filter is for: '' anyone, a staff name, or ME for the signed-in reader. */
export const ME = '@me';

/** The signed-in reader's staff name, when known. The draft sets it on window; the app would take it from the session. */
export const myName = (): string | null => (typeof window !== 'undefined' && (window as { demiMe?: string }).demiMe) || null;

/** EPIC.track's rule for My Workplans: on the work's team (lead included) or its responsible EPD. */
export const isOn = (work: WorkplanRow, name: string) => (work.staff ?? []).some((s) => s.name === name);

export const whoName = (who: string) => (who === ME ? myName() : who || null);

/** True when `work` passes the Assigned to and Team filters. */
export function assignedOk(work: WorkplanRow, who: string, team: string): boolean {
  // Me with no signed-in name known filters nothing: the select has no Me option then and reads Anyone.
  const name = whoName(who);
  if (name && !isOn(work, name)) return false;
  if (team && work.team !== team) return false;
  return true;
}

/** The roles `name` holds on `work`, in Track's order. */
export const rolesOf = (work: WorkplanRow, name: string) => (work.staff ?? []).filter((s) => s.name === name).map((s) => s.role);

/** Everyone and every team named on `works`, sorted, and how many works have no one: sheet works. */
export function peopleOf(works: readonly WorkplanRow[]) {
  const names = new Set<string>();
  const teams = new Set<string>();
  let unassigned = 0;
  for (const w of works) {
    (w.staff ?? []).forEach((s) => names.add(s.name));
    if (w.team) teams.add(w.team);
    if (!(w.staff ?? []).length) unassigned += 1;
  }
  const sort = (a: string, b: string) => a.localeCompare(b);
  return { names: [...names].sort(sort), teams: [...teams].sort(sort), unassigned };
}
