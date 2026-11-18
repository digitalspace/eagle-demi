import { useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Link } from 'react-router';
import { dayMonthYear } from '../dates';
import { WorkPill } from '../screens/SheetWorksPanel';
import { useNarrow } from '../shell/useNarrow';
import { PIPELINE_COLUMNS, toneOf, type PipelineColumn, type WorkRow } from './derive';
import { unmeasuredStatus } from './timeline-rows';
import './workplans.css';
import './pipeline.css';

const PAGE = 100;
/** Stacked columns (pipeline.css) have no scroll box of their own, so each shows fewer cards before Show more. */
const STACKED_PAGE = 5;
const STACKED_QUERY = '(max-width: 40rem)';
const count = (n: number) => n.toLocaleString('en-CA');
const works = (n: number) => `${count(n)} ${n === 1 ? 'work' : 'works'}`;

/** Overdue first, most days over first (only overdue rows have days over); then the most of its phase used; then by title. */
function byPhaseUse(a: WorkRow, b: WorkRow): number {
  return (
    b.daysOver - a.daysOver ||
    (b.percentUsed ?? -1) - (a.percentUsed ?? -1) ||
    (a.work.title ?? '').localeCompare(b.work.title ?? '')
  );
}

/** Overdue or near-limit flag on the phase line; text, so the bar colour is never the only sign. */
function Flag({ row }: { row: WorkRow }) {
  if (row.overdue) return <span className="pill pill--danger pl-flag">{row.daysOver} d over</span>;
  if (row.bar === 'near-limit') return <span className="pill pill--warning pl-flag">{row.percentUsed} % used</span>;
  return null;
}

function Phase({ row }: { row: WorkRow }) {
  let name = row.current ? row.current.name || 'Unnamed phase' : 'No current phase';
  if (row.notStarted) name = 'Not started';
  return (
    <span className="pl-phase">
      <span className={`pl-swatch pl-swatch--${row.current ? toneOf(row) : 'waiting'}`} aria-hidden="true" />
      <span>{name}</span>
      <Flag row={row} />
    </span>
  );
}

function Days({ row }: { row: WorkRow }) {
  const { daysInPhase: used, plannedDays: planned } = row;
  const status = unmeasuredStatus(row);
  if (status) return <span className="pl-figure">{status}</span>;
  if (used === null) return null;
  if (!planned) {
    return <span className="pl-figure">{`${used} d in phase, ${row.suspended ? 'suspended' : 'no planned length'}`}</span>;
  }
  const fill = row.bar ?? 'normal';
  return (
    <span className="pl-days">
      <span className="progress pl-bar" aria-hidden="true">
        <span
          className={`progress__fill pl-bar__fill pl-bar__fill--${fill}`}
          style={{ width: `${Math.min(100, row.percentUsed ?? 0)}%` }}
        />
      </span>
      <span className={`pl-figure${row.overdue ? ' pl-figure--overdue' : ''}`}>
        {row.suspended ? (
          <>
            {used} d <span className="visually-hidden">in phase</span>, suspended
          </>
        ) : (
          <>
            {used} / {planned} d <span className="visually-hidden">in phase</span>
          </>
        )}
      </span>
    </span>
  );
}

function Next({ row }: { row: WorkRow }) {
  let text = 'No dated next step';
  if (row.notStarted && row.next) text = `Starts ${dayMonthYear(row.next.date)}`;
  else if (row.overdue) text = row.next ? `Blocking: ${row.next.name}` : 'Blocking the decision';
  else if (row.next) text = `Next: ${row.next.name}, ${dayMonthYear(row.next.date)}`;
  return (
    <span className="pl-next">
      <span>{text}</span>
      {row.suspended && (
        <span className="pill pill--neutral pl-flag">
          {row.suspendedUnder ? `Suspended ${row.suspendedUnder}` : 'Suspended'}
        </span>
      )}
    </span>
  );
}

function Card({ row }: { row: WorkRow }) {
  const { work } = row;
  const title = work.title || 'Untitled work';
  // Track titles already start with the project name; repeating it would only push the type off the line.
  const project = work.projectName && !title.startsWith(work.projectName) ? work.projectName : null;
  const kind = [project, work.workType ?? work.workTypeCode, work.actYear ? `${work.actYear} Act` : null].filter(Boolean);
  return (
    <li className="pl-card">
      <Link className="pl-work" to={`/project-details/${encodeURIComponent(work.projectId)}`} title={title}>
        {title}
      </Link>
      {kind.length > 0 && <span className="pl-sub">{kind.join(' · ')}</span>}
      <WorkPill work={work} />
      <Phase row={row} />
      <Days row={row} />
      <Next row={row} />
    </li>
  );
}

function Column({ name, rows }: { name: PipelineColumn; rows: WorkRow[] }) {
  const page = useNarrow(STACKED_QUERY) ? STACKED_PAGE : PAGE;
  const [pages, setPages] = useState(1);
  const visible = rows.slice(0, page * pages);
  const more = Math.min(page, rows.length - visible.length);
  const list = useRef<HTMLUListElement>(null);
  // The button may go away, so focus moves to the first card it revealed.
  const showMore = () => {
    flushSync(() => setPages((n) => n + 1));
    list.current?.querySelectorAll<HTMLElement>('.pl-work')[visible.length]?.focus();
  };
  const overdue = rows.filter((row) => row.overdue).length;
  const id = `pl-col-${name.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <section className="pl-col" aria-labelledby={id}>
      <h2 className="pl-col__head" id={id}>
        {/* Spaces between the spans keep the heading's spoken name apart: "Review 3 works 1 overdue". */}
        <span>{name}</span>{' '}
        <span className="pl-col__count">
          {count(rows.length)}{' '}
          <span className="visually-hidden">{rows.length === 1 ? 'work' : 'works'}</span>
        </span>
        {overdue > 0 && (
          <>
            {' '}
            <span className="pl-col__overdue">{count(overdue)} overdue</span>
          </>
        )}
      </h2>
      <div className="pl-col__body">
        {rows.length === 0 ? (
          <p className="pl-empty">No open works in this stage.</p>
        ) : (
          <ul className="pl-cards" ref={list}>
            {visible.map((row) => (
              <Card key={`${row.work.source}:${row.work.workId}`} row={row} />
            ))}
          </ul>
        )}
        {more > 0 && (
          <button type="button" className="pl-more" onClick={showMore}>
            Show {more} more{' '}
            <span className="visually-hidden">in {name}</span>
          </button>
        )}
      </div>
    </section>
  );
}

/** Open works in five stage columns by their current phase; not-started works wait in Intake, closed ones are left out. */
export function PipelineView({ rows, today }: { rows: WorkRow[]; today: string }) {
  const byColumn = useMemo(() => {
    const groups = new Map<PipelineColumn, WorkRow[]>(PIPELINE_COLUMNS.map((name) => [name, []]));
    for (const row of rows) if (row.column) groups.get(row.column)?.push(row);
    for (const group of groups.values()) group.sort(byPhaseUse);
    return groups;
  }, [rows]);
  const open = rows.filter((row) => row.column).length;
  const closed = rows.length - open;

  if (rows.length === 0) {
    return (
      <div className="pl">
        <p className="panel pl-none">No works match these filters.</p>
      </div>
    );
  }
  return (
    <div className="pl">
      <div className="pl-board">
        {PIPELINE_COLUMNS.map((name) => (
          <Column key={name} name={name} rows={byColumn.get(name) ?? []} />
        ))}
      </div>
      <p className="pl-footer" role="status">
        {works(open)} open on {dayMonthYear(today)}.
        {closed > 0 && ` ${works(closed)} closed, not shown.`}
      </p>
    </div>
  );
}
