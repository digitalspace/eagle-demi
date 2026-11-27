import { useId } from 'react';
import { ME, myName, whoName } from './assigned';

export interface People {
  names: string[];
  teams: string[];
  /** Works with no one on them (sheet works): hidden while Assigned to or Team is set. */
  unassigned: number;
}

/** Assigned to and Team, as two selects; shared by the Timeline and the other views. */
export function AssignedFields({ who, team, people, change }: { who: string; team: string; people: People; change: (c: { who?: string; team?: string }) => void }) {
  const whoId = useId();
  const teamId = useId();
  const noteId = useId();
  const me = myName();
  const whoLabel = who === ME ? `Me${me ? ` (${me})` : ''}` : who || 'Anyone';
  const narrowed = Boolean(whoName(who) || team) && people.unassigned > 0;
  return (
    <>
      <div className="wp-ov-fld wp-ov-fld--pick">
        <label className="wp-ov-tlab" htmlFor={whoId}>
          Assigned to
        </label>
        <select id={whoId} className="wp-dsel" value={who} title={`Assigned to: ${whoLabel}`} aria-describedby={narrowed ? noteId : undefined} onChange={(event) => change({ who: event.target.value })}>
          <option value="">Anyone</option>
          {me && <option value={ME}>Me ({me})</option>}
          {/* A name picked from the URL stays offered even when no work has it. */}
          {[...new Set([...people.names, ...(who && who !== ME ? [who] : [])])].map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <div className="wp-ov-fld wp-ov-fld--pick">
        <label className="wp-ov-tlab" htmlFor={teamId}>
          Team
        </label>
        <select id={teamId} className="wp-dsel" value={team} title={`Team: ${team || 'Any'}`} aria-describedby={narrowed ? noteId : undefined} onChange={(event) => change({ team: event.target.value })}>
          <option value="">Any</option>
          {[...new Set([...people.teams, ...(team ? [team] : [])])].map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
      {/* Always rendered, so the note is announced when a filter brings it. */}
      <p className={narrowed ? 'wp-ov-fnote' : 'wp-ov-fnote visually-hidden'} id={noteId} aria-live="polite">
        {narrowed && (
          <>
            {people.unassigned === 1 ? '1 sheet work has' : `${people.unassigned} sheet works have`} no one assigned in Track and {people.unassigned === 1 ? 'is' : 'are'} hidden by these filters.
          </>
        )}
      </p>
    </>
  );
}
