import { useRef } from 'react';
import { Link } from 'react-router';
import { dayMonthYear } from '../dates';
import { WorkPill } from '../screens/SheetWorksPanel';
import { toneOf, type WorkRow } from './derive';
import { shortDate } from './format';
import { suspendedFigure, unmeasuredStatus } from './timeline-rows';
import { DetailsToggle, WorkDetails } from './WorkDetails';
import { useFollowDetails } from './use-follow-details';
import { closedNoteOf, projectDetailsPath } from './work-notes';

export const COLUMNS = 6;

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

const detailsId = (row: WorkRow) => `sl-details-${row.work.workId}`;
/** Scrolls the pane into view below the sticky head and the row that opened it. */
function reveal(pane: HTMLElement) {
  const head = pane.closest('table')?.tHead?.offsetHeight ?? 0;
  const row = pane.closest('tr')?.previousElementSibling as HTMLElement | null;
  pane.style.scrollMarginTop = `${head + (row?.offsetHeight ?? 0)}px`;
  pane.scrollIntoView({ block: 'nearest' });
}

interface Toggle {
  open: boolean;
  onToggle: () => void;
}

export function WorkCell({ row, details }: { row: WorkRow; details: Toggle | null }) {
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
        <DetailsToggle className="sl-toggle" title={title} controls={detailsId(row)} open={details.open} onToggle={details.onToggle} />
      )}
    </td>
  );
}

export function DetailRow({ row, follow, onFollowed }: { row: WorkRow; follow: boolean; onFollowed: () => void }) {
  const pane = useRef<HTMLDivElement>(null);
  useFollowDetails(pane, follow, reveal, onFollowed);
  return (
    <tr className="sl-detail">
      <td colSpan={COLUMNS}>
        <div className="sl-detail__pane" ref={pane}>
          <WorkDetails row={row} id={detailsId(row)} />
        </div>
      </td>
    </tr>
  );
}

export function PhaseCell({ row, today }: { row: WorkRow; today: string }) {
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
        {row.next && <span className="sl-sub">Starts {shortDate(row.next.date, today)}</span>}
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
  let figure = `${used}/${planned}`;
  let spoken = `${used} of ${planned} planned days${fill === 'near-limit' ? `, ${row.percentUsed} % used, near the limit` : ''}`;
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

export function DaysCell({ row }: { row: WorkRow }) {
  const breakdown = breakdownOf(row);
  return (
    <td>
      <DaysFigure row={row} />
      {breakdown && <span className="sl-sub">{breakdown}</span>}
    </td>
  );
}

export function NextCell({ row, today }: { row: WorkRow; today: string }) {
  const suspended = row.suspended && (
    <span className="pill pill--neutral sl-pill">
      {row.suspendedUnder ? `Suspended ${row.suspendedUnder}` : 'Suspended'}
    </span>
  );
  if (row.overdue) {
    return (
      <td className="sl-cell--clip">
        {row.next ? <span className="sl-clip">{row.next.name} (blocked)</span> : <Blank says="No next milestone" />}
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
        {shortDate(row.next.date, today)} · in {row.next.inDays} d
      </span>
      {suspended}
    </td>
  );
}

export function LifecycleCell({ row }: { row: WorkRow }) {
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
            title={segment.name ? `${segment.name}, ${dayMonthYear(segment.start)} to ${dayMonthYear(segment.end)}` : undefined}
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

export function DecisionCell({ row }: { row: WorkRow }) {
  if (!row.decisionDate) {
    return (
      <td>
        <Blank says="No decision date" />
      </td>
    );
  }
  return (
    <td className="cell--nowrap" title={row.decisionExpected ? 'Expected decision' : undefined}>
      {monthYear(row.decisionDate)}
      {row.decisionExpected && <span className="visually-hidden">, expected</span>}
    </td>
  );
}
