import { useId } from 'react';
import type { WorkplanRow } from '../api/sheet-works';
import { workStateText } from './record-header';

const LEAD = 'Work lead';
const EPD = 'Responsible EPD';

/** The work's own name without the project name in front, as the chart's row labels show it. */
const nameOf = (w: WorkplanRow) => {
  const t = w.title ?? '';
  const pre = `${w.projectName ?? ''} - `;
  return (w.projectName && t.startsWith(pre) ? t.slice(pre.length) : t) || w.workType || 'Work';
};

/** Who is on each of the project's works under this Act, from Track, as one table: one row per work. */
export function RecordPeople({ works }: { works: readonly WorkplanRow[] }) {
  const captionId = useId();
  const staffed = works.filter((w) => (w.staff ?? []).length);
  if (!staffed.length) return null;
  // The header says the team when every work shares it; a Team column only when they differ.
  const manyTeams = new Set(staffed.map((w) => w.team ?? '')).size > 1;
  const names = (w: WorkplanRow, role: string) => (w.staff ?? []).filter((s) => s.role === role).map((s) => s.name).join(', ') || '—';
  const others = (w: WorkplanRow) =>
    (w.staff ?? [])
      .filter((s) => s.role !== LEAD && s.role !== EPD)
      .map((s) => `${s.name} (${s.role})`)
      .join(', ') || '—';
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region needs a keyboard stop
    <div className="wp-rec-people" tabIndex={0} role="region" aria-labelledby={captionId}>
      <table className="wp-rec-people__table">
        <caption className="visually-hidden" id={captionId}>
          People on each work under this Act
        </caption>
        <thead>
          <tr>
            <th scope="col">Work</th>
            <th scope="col">Work state</th>
            {manyTeams && <th scope="col">Team</th>}
            <th scope="col">{LEAD}</th>
            <th scope="col">{EPD}</th>
            <th scope="col">Team members</th>
          </tr>
        </thead>
        <tbody>
          {staffed.map((w) => (
            <tr key={w.workId}>
              <th scope="row">{nameOf(w)}</th>
              <td>{workStateText(w)}</td>
              {manyTeams && <td>{w.team ?? '—'}</td>}
              <td>{names(w, LEAD)}</td>
              <td>{names(w, EPD)}</td>
              <td>{others(w)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
