import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { dayMonthYear } from '../dates';
import { WorkPill } from '../screens/SheetWorksPanel';
import { STATUS_LABEL, byAttention, toneOf, type WorkRow, type WorkStatus } from './derive';
import { suspendedFigure, unmeasuredStatus } from './timeline-rows';
import { WorkDetails } from './WorkDetails';
import { closedNoteOf, hasDetails, projectDetailsPath } from './work-notes';
import './workplans.css';
import './status-list.css';

const TILES: WorkStatus[] = ['overdue', 'next-30', 'on-track', 'not-started', 'closed'];
const PAGE = 200;
const COLUMNS = 6;
const count = (n: number) => n.toLocaleString('en-CA');

/** "1 Mar 2026" to "Mar 2026". */
const monthYear = (iso: string | null) => dayMonthYear(iso).replace(/^\d+ /, '');

/** A dash for sighted readers, words for a screen reader. */
function Blank({ says }: { says: string }) {
  return (
    <>
      <span aria-hidden="true">—</span>
      <span className="visually-hidden">{says}</span>
    </>
  );
}

const rowKey = (row: WorkRow) => `${row.work.source}:${row.work.workId}`;
const detailsId = (row: WorkRow) => `sl-details-${row.work.workId}`;
/** Module-level so React calls it once, when the pane mounts, not on every render. */
const reveal = (pane: HTMLDivElement | null) => {
  pane?.scrollIntoView({ block: 'nearest' });
};

interface Toggle {
  open: boolean;
  onToggle: () => void;
}

function WorkCell({ row, details }: { row: WorkRow; details: Toggle | null }) {
  const { work } = row;
  const kind = [work.workType ?? work.workTypeCode, work.actYear ? `${work.actYear} Act` : null].filter(Boolean);
  const title = work.title || 'Untitled work';
  return (
    <td className="sl-cell--clip">
      <Link className="sl-work" to={projectDetailsPath(work.projectId)} title={work.title ?? undefined}>
        {title}
      </Link>
      {kind.length > 0 && <span className="sl-sub">{kind.join(' · ')}</span>}
      <WorkPill work={work} />
      {details && (
        <button
          type="button"
          className="sl-toggle"
          aria-expanded={details.open}
          aria-controls={detailsId(row)}
          aria-label={`Details for ${title}`}
          onClick={details.onToggle}
        >
          <svg className="sl-toggle__chevron" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
            <path d="M3.5 1.5 7 5 3.5 8.5" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
          Details
        </button>
      )}
    </td>
  );
}

function PhaseCell({ row }: { row: WorkRow }) {
  if (row.closed) {
    const closedNote = closedNoteOf(row.work);
    return (
      <td className="sl-cell--clip">
        <span className="sl-phase">
          <span className="sl-swatch sl-swatch--closed" aria-hidden="true" />
          Closed
        </span>
        {closedNote && <span className="sl-sub">{closedNote}</span>}
      </td>
    );
  }
  if (row.notStarted) {
    return (
      <td className="sl-cell--clip">
        <span className="sl-phase">
          <span className="sl-swatch sl-swatch--waiting" aria-hidden="true" />
          Not started
        </span>
        {row.next && <span className="sl-sub">Starts {dayMonthYear(row.next.date)}</span>}
      </td>
    );
  }
  const swatch = `sl-swatch--${row.current ? toneOf(row) : 'waiting'}`;
  return (
    <td className="sl-cell--clip">
      <span className="sl-phase">
        <span className={`sl-swatch ${swatch}`} aria-hidden="true" />
        <span className="sl-clip">{row.current ? row.current.name || 'Unnamed phase' : 'No current phase'}</span>
      </span>
      {row.column && <span className="sl-sub">{row.column}</span>}
    </td>
  );
}

/** "includes 30 d extension, 12 d suspended", from whichever is above 0; planned days already count both. */
function breakdownOf(row: WorkRow): string | null {
  const extension = row.current?.extensionDays ?? 0;
  const suspended = row.current?.suspendedDays ?? 0;
  const parts = [extension > 0 && `${extension} d extension`, suspended > 0 && `${suspended} d suspended`].filter(Boolean);
  return parts.length ? `includes ${parts.join(', ')}` : null;
}

function DaysFigure({ row }: { row: WorkRow }) {
  const { daysInPhase: used, plannedDays: planned } = row;
  const status = unmeasuredStatus(row);
  if (status) return <span className="sl-figure">{status}</span>;
  if (used === null) return <Blank says="No current phase" />;
  if (!planned) {
    if (row.suspended) return <span className="sl-figure">{suspendedFigure(used)}</span>;
    return (
      <span className="sl-figure">
        {used} d<span className="visually-hidden"> in phase, no planned length</span>
      </span>
    );
  }
  const fill = row.bar ?? 'normal';
  let figure = `${used}/${planned}${fill === 'near-limit' ? ` · ${row.percentUsed} %` : ''}`;
  let spoken = `${used} of ${planned} planned days${fill === 'near-limit' ? ', near the limit' : ''}`;
  if (row.overdue) {
    figure = `${used}/${planned} · +${row.daysOver}`;
    spoken = `${used} of ${planned} planned days, ${row.daysOver} over`;
  } else if (row.suspended) {
    figure = suspendedFigure(used);
    spoken = `${used} of ${planned} planned days, suspended`;
  }
  return (
    <span className="sl-days">
      <span className="progress sl-bar" aria-hidden="true">
        <span
          className={`progress__fill sl-bar__fill sl-bar__fill--${fill}`}
          style={{ width: `${Math.min(100, row.percentUsed ?? 0)}%` }}
        />
      </span>
      <span className={`sl-figure${row.overdue ? ' sl-figure--overdue' : ''}`} aria-hidden="true">
        {figure}
      </span>
      <span className="visually-hidden">{spoken}</span>
    </span>
  );
}

function DaysCell({ row }: { row: WorkRow }) {
  const breakdown = breakdownOf(row);
  return (
    <td>
      <DaysFigure row={row} />
      {breakdown && <span className="sl-sub">{breakdown}</span>}
    </td>
  );
}

function NextCell({ row }: { row: WorkRow }) {
  const suspended = row.suspended && (
    <span className="pill pill--neutral sl-pill">
      {row.suspendedUnder ? `Suspended ${row.suspendedUnder}` : 'Suspended'}
    </span>
  );
  if (row.overdue) {
    return (
      <td className="sl-cell--clip">
        {row.next && <span className="sl-clip">{row.next.name}</span>}
        <span className="sl-sub sl-sub--overdue">Waiting on {row.current?.name || 'the current phase'}</span>
        {suspended}
      </td>
    );
  }
  if (!row.next) {
    return (
      <td>
        <Blank says="No next milestone" />
        {suspended}
      </td>
    );
  }
  return (
    <td className="sl-cell--clip">
      <span className="sl-clip">{row.next.name}</span>
      <span className={`sl-sub${row.status === 'next-30' ? ' sl-sub--soon' : ''}`}>
        {dayMonthYear(row.next.date)} · in {row.next.inDays} d
      </span>
      {suspended}
    </td>
  );
}

function LifecycleCell({ row }: { row: WorkRow }) {
  const { segments, todayAt } = row;
  if (!segments.length) {
    return (
      <td>
        <Blank says="No dated phases" />
      </td>
    );
  }
  const first = segments.reduce((min, s) => (s.start < min ? s.start : min), segments[0].start);
  const last = segments.reduce((max, s) => (s.end > max ? s.end : max), segments[0].end);
  const current = toneOf(row);
  return (
    <td>
      <span className="sl-strip" aria-hidden="true">
        {segments.map((segment, i) => (
          <span
            key={i}
            className={`sl-strip__seg sl-strip__seg--${segment.state === 'current' ? current : segment.state}`}
            style={{ left: `${segment.offset * 100}%`, width: `max(2px, calc(${segment.share * 100}% - 1px))` }}
            title={segment.name ?? undefined}
          />
        ))}
        {todayAt !== null && !row.closed && <span className="sl-strip__today" style={{ left: `${todayAt * 100}%` }} />}
      </span>
      <span className="sl-sub">
        {monthYear(first)} <span aria-hidden="true">→</span>
        <span className="visually-hidden">to</span> {monthYear(last)}
      </span>
    </td>
  );
}

function DecisionCell({ row }: { row: WorkRow }) {
  if (!row.decisionDate) {
    return (
      <td>
        <Blank says="No decision date" />
      </td>
    );
  }
  return (
    <td className="cell--nowrap">
      {monthYear(row.decisionDate)}
      {row.decisionExpected && <span className="sl-sub">Expected</span>}
    </td>
  );
}

const EMPTY: Record<WorkStatus | 'open', string> = {
  open: 'No open works. Choose Closed to see finished works.',
  overdue: 'No work is past the planned end of its phase.',
  'next-30': 'No work has a milestone in the next 30 days.',
  'on-track': 'No work is on track with a later milestone.',
  'not-started': 'Every open work has started.',
  unknown: 'Every open work has a planned end after its start.',
  inactive: 'No inactive works.',
  closed: 'No closed works.',
};

function Tiles({
  counts,
  pressed,
  onPress,
}: {
  counts: Record<WorkStatus, number>;
  pressed: WorkStatus | null;
  onPress: (status: WorkStatus) => void;
}) {
  return (
    <div className="sl-tiles" role="group" aria-label="Show works by status">
      {TILES.map((status) => (
        <button
          key={status}
          type="button"
          className={`sl-tile sl-tile--${status}`}
          aria-pressed={pressed === status}
          onClick={() => onPress(status)}
        >
          <span className="sl-tile__count">{count(counts[status])}</span>
          <span className="sl-tile__label">{STATUS_LABEL[status]}</span>
        </button>
      ))}
    </div>
  );
}

/** Works sorted by attention, open ones by default; each status tile narrows the table to its status. */
export function StatusListView({ rows, today }: { rows: WorkRow[]; today: string }) {
  const [pressed, setPressed] = useState<WorkStatus | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const counts = useMemo(() => {
    const tally = Object.fromEntries(Object.keys(STATUS_LABEL).map((status) => [status, 0])) as Record<WorkStatus, number>;
    for (const row of rows) tally[row.status] += 1;
    return tally;
  }, [rows]);
  const shown = useMemo(
    () =>
      rows
        .filter((row) => (pressed ? row.status === pressed : row.status !== 'closed'))
        .sort(byAttention),
    [rows, pressed],
  );
  const visible = shown.slice(0, limit);
  const more = Math.min(PAGE, shown.length - visible.length);

  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const press = (status: WorkStatus) => {
    setPressed((current) => (current === status ? null : status));
    setLimit(PAGE);
  };

  return (
    <div className="sl">
      <Tiles counts={counts} pressed={pressed} onPress={press} />
      <div className="panel panel--scroll sl-region">
        <table className="sl-table">
          <caption className="visually-hidden">
            {pressed ? `${STATUS_LABEL[pressed]} works` : 'Open works'} on {dayMonthYear(today)}, sorted by attention
          </caption>
          <thead>
            <tr>
              <th scope="col" className="sl-col--work">Work</th>
              <th scope="col" className="sl-col--phase">Current phase</th>
              <th scope="col" className="sl-col--days">Days in phase</th>
              <th scope="col" className="sl-col--next">Next milestone</th>
              <th scope="col" className="sl-col--life">Lifecycle</th>
              <th scope="col" className="sl-col--decision">Est. decision</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const key = rowKey(row);
              const isOpen = open.has(key);
              return (
                <Fragment key={key}>
                  <tr>
                    <WorkCell row={row} details={hasDetails(row) ? { open: isOpen, onToggle: () => toggle(key) } : null} />
                    <PhaseCell row={row} />
                    <DaysCell row={row} />
                    <NextCell row={row} />
                    <LifecycleCell row={row} />
                    <DecisionCell row={row} />
                  </tr>
                  {isOpen && (
                    <tr className="sl-detail">
                      <td colSpan={COLUMNS}>
                        <div className="sl-detail__pane" ref={reveal}>
                          <WorkDetails row={row} id={detailsId(row)} />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={COLUMNS} className="sl-empty">
                  {rows.length === 0 ? 'No works match these filters.' : EMPTY[pressed ?? 'open']}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="sl-footer">
        <span role="status">
          Showing {count(visible.length)} of {count(shown.length)}
          {pressed ? '.' : ` open ${shown.length === 1 ? 'work' : 'works'}.`}
          {!pressed &&
            counts.closed > 0 &&
            ` ${count(counts.closed)} closed ${counts.closed === 1 ? 'work is' : 'works are'} under the Closed tile.`}
        </span>
        {more > 0 && (
          <button type="button" className="sl-more" onClick={() => setLimit((n) => n + PAGE)}>
            Show {more} more
          </button>
        )}
      </div>
    </div>
  );
}
