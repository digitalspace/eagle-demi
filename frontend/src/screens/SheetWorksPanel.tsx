import { useId, useState } from 'react';
import { ApiError } from '../api/client';
import { useSheetWorks, type SheetMilestone, type SheetPhase, type SheetWork, type Undated } from '../api/sheet-works';
import { dayMonthYear } from '../dates';
import { phasesInOrder } from '../workplans/derive';

// An Act with more works than this starts folded; each work lists all its phases and milestones.
const OPEN_UP_TO = 5;

/** `label` and the date, or the latest day it can be when the sheet left it out. Null when neither is known. */
function dated(label: string, value: string | null, undated: Undated, key: string): string | null {
  if (value) return `${label} ${dayMonthYear(value)}`;
  const notAfter = undated?.[key]?.notAfter;
  return notAfter ? `${label} date not known, before ${dayMonthYear(notAfter)}` : null;
}

const daysText = (days: number | null) => (days === null ? null : `${days} ${days === 1 ? 'day' : 'days'}`);
const joined = (parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(' · ');
const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function DateCell({ value }: { value: string | null }) {
  return (
    <span className="ps-list__date">
      {dayMonthYear(value) || (
        <>
          <span aria-hidden="true">—</span>
          <span className="visually-hidden">Date not known</span>
        </>
      )}
    </span>
  );
}

/** Works by Act year, oldest Act first; a work with no year goes last. */
function groupByAct(works: SheetWork[]): [number | null, SheetWork[]][] {
  const groups = new Map<number | null, SheetWork[]>();
  for (const work of works) {
    const group = groups.get(work.actYear);
    if (group) group.push(work);
    else groups.set(work.actYear, [work]);
  }
  return [...groups].sort(([a], [b]) => (a ?? Infinity) - (b ?? Infinity));
}

/** How the public read treats a sheet work once it shows sheet works; null for a work it shows as is. */
export function WorkPill({ work }: { work: Pick<SheetWork, 'shownAfterFlip' | 'replaces' | 'untilTrack'> }) {
  if (!work.shownAfterFlip) return <span className="pill pill--neutral">Hidden when the public site shows sheet works</span>;
  if (work.replaces.length) {
    const titles = work.replaces.map((track) => track.title).filter(Boolean);
    return (
      <span className="pill pill--warning">
        {titles.length ? `Replaces Track work: ${titles.join(', ')}` : 'Replaces a Track work'}
      </span>
    );
  }
  if (work.untilTrack) return <span className="pill pill--info">Shown until Track has it</span>;
  return null;
}

function PhaseRow({ phase }: { phase: SheetPhase }) {
  const text = joined([
    !phase.startDate && dated('Start', null, phase.undated, 'startDate'),
    dated('To', phase.endDate, phase.undated, 'endDate'),
    daysText(phase.numberOfDays),
  ]);
  return (
    <li className="ps-list__row">
      <DateCell value={phase.startDate} />
      <span>
        <span className="ps-list__title">{phase.name || 'Unnamed phase'}</span>
        {text && <span className="ps-list__text">{text}</span>}
        {phase.interruptions.map((stop, i) => (
          <span key={i} className="ps-list__text">
            {joined([
              [stop.kind && capitalised(stop.kind), stop.legalSection].filter(Boolean).join(' ') || 'Interruption',
              dated('from', stop.startDate, null, 'startDate'),
              dated('to', stop.endDate, null, 'endDate'),
              daysText(stop.days),
            ])}
          </span>
        ))}
      </span>
    </li>
  );
}

function MilestoneRow({ milestone }: { milestone: SheetMilestone }) {
  const expected = !milestone.actualDate && milestone.anticipatedDate;
  const text = joined([
    !milestone.actualDate && dated('Actual', null, milestone.undated, 'actualDate'),
    expected && `Expected ${dayMonthYear(milestone.anticipatedDate)}`,
    dated('To', milestone.endDate, milestone.undated, 'endDate'),
    daysText(milestone.numberOfDays),
    milestone.outcome,
  ]);
  return (
    <li className="ps-list__row">
      <DateCell value={milestone.actualDate} />
      <span>
        <span className="ps-list__title">{milestone.name || 'Unnamed milestone'}</span>
        {text && <span className="ps-list__text">{text}</span>}
      </span>
    </li>
  );
}

/** One sheet work as a `ps-list` row: dates, outcome, phases and milestones. Callers wrap it in a `ul.ps-list`. */
export function SheetWorkRow({ work }: { work: SheetWork }) {
  const expected = !work.decisionDate && work.anticipatedDecisionDate;
  const toAct = work.transitionOut?.toActYear;
  const movedOn = work.transitionOut?.date;
  const lines = [
    joined([
      work.workType,
      !work.startDate && dated('Start', null, work.undated, 'startDate'),
      dated('Decision', work.decisionDate, work.undated, 'decisionDate'),
      expected && `Decision expected ${dayMonthYear(work.anticipatedDecisionDate)}`,
    ]),
    joined([work.outcome, !!toAct && `Moved to the ${toAct} Act${movedOn ? ` on ${dayMonthYear(movedOn)}` : ''}`]),
  ].filter(Boolean);
  const phases = phasesInOrder(work.phases);
  const listId = useId();
  return (
    <li className="ps-list__row">
      <DateCell value={work.startDate} />
      <div>
        <span className="ps-list__title">
          {work.title || 'Untitled work'} <WorkPill work={work} />
        </span>
        {lines.map((line, i) => (
          <span key={i} className="ps-list__text">
            {line}
          </span>
        ))}
        {phases.length > 0 && (
          <>
            <p className="micro-label" id={`${listId}-phases`}>
              Phases
            </p>
            <ul className="ps-list ps-list--nested" aria-labelledby={`${listId}-phases`}>
              {phases.map((phase, i) => (
                <PhaseRow key={i} phase={phase} />
              ))}
            </ul>
          </>
        )}
        {work.milestones.length > 0 && (
          <>
            <p className="micro-label" id={`${listId}-milestones`}>
              Milestones
            </p>
            <ul className="ps-list ps-list--nested" aria-labelledby={`${listId}-milestones`}>
              {work.milestones.map((milestone, i) => (
                <MilestoneRow key={i} milestone={milestone} />
              ))}
            </ul>
          </>
        )}
      </div>
    </li>
  );
}

function ActGroup({ actYear, works }: { actYear: number | null; works: SheetWork[] }) {
  // Decided once when the group mounts, so a refetch never snaps an open group shut.
  const [open, setOpen] = useState(works.length <= OPEN_UP_TO);
  return (
    <details className="ps-sources" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="ps-sources__summary">
        {actYear ? `${actYear} Act` : 'Act not known'} ({works.length})
      </summary>
      <ul className="ps-list">
        {works.map((work) => (
          <SheetWorkRow key={work.workId} work={work} />
        ))}
      </ul>
    </details>
  );
}

function SheetWorksBody({ works }: { works: SheetWork[] | undefined }) {
  if (!works) return <p className="ps-note">Only staff can see the sheet works.</p>;
  if (!works.length) return <p className="ps-note">No works from the business spreadsheets are stored for this project.</p>;
  return groupByAct(works).map(([actYear, group]) => <ActGroup key={actYear ?? 'none'} actYear={actYear} works={group} />);
}

/** Works loaded from the business spreadsheets for one project, with how the public read would treat each. */
export function SheetWorksPanel({ projectId }: { projectId: string }) {
  const { data: works, error } = useSheetWorks(projectId);
  // Shown after one good read or a 403 only: outside dev and test the route is not served, and
  // other failures have nothing for staff to act on. Works already shown stay on a later failure.
  if (!works && !(error instanceof ApiError && error.status === 403)) return null;
  return (
    <section className="ps-section" aria-labelledby="ps-sheet-works-h">
      <h2 id="ps-sheet-works-h" className="ps-section__title">
        Business sheet works (1996 and 2002 Acts)
      </h2>
      <p className="ps-section__lede">
        Loaded on test environments from the business spreadsheets. The public site does not show these works yet.
      </p>
      <SheetWorksBody works={works} />
    </section>
  );
}
