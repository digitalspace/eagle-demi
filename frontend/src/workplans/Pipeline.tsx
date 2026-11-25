import { useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { Link } from 'react-router';
import { WorkPill } from '../screens/SheetWorksPanel';
import { useNarrow } from '../shell/useNarrow';
import { PIPELINE_COLUMNS, rowKey, suspendedFigure, toneOf, unmeasuredStatus, type PipelineColumn, type WorkRow } from './derive';
import type { ViewProps } from './Filters';
import { count, plural, shortDate } from './format';
import './workplans.css';
import './pipeline.css';

const PAGE = 100;
/** Stacked columns (pipeline.css) have no scroll box of their own, so each shows fewer cards before Show more. */
const STACKED_PAGE = 5;
const STACKED_QUERY = '(max-width: 40rem)';

/** What each column holds, as `columnOf` in derive.ts maps phases to columns. */
const COLUMN_NOTE: Record<PipelineColumn, string> = {
  Intake: 'Initial Contact · Pre-EA · not yet started',
  Planning: 'Procedures · Early Engagement · Readiness · Process Planning',
  'Proponent time': 'Application / DPD development by proponent',
  Review: 'Completeness · Application & Effects review · Post decision',
  Decision: 'Recommendation · Decision',
};

/** Overdue first, most days over first (only overdue rows have days over); then the most of its phase used; then by title. */
function byPhaseUse(a: WorkRow, b: WorkRow): number {
  // Inactive and unknown works hide their bar, so a figure the reader cannot see must not rank them.
  const used = (row: WorkRow) => (unmeasuredStatus(row) ? -1 : (row.percentUsed ?? -1));
  return b.daysOver - a.daysOver || used(b) - used(a) || (a.work.title ?? '').localeCompare(b.work.title ?? '');
}

function Phase({ row }: { row: WorkRow }) {
  let name = row.current ? row.current.name || 'Unnamed phase' : 'No current phase';
  if (row.notStarted) name = 'Not started';
  return (
    <span className="pl-phase">
      <span className={`pl-swatch pl-swatch--${row.current ? toneOf(row) : 'waiting'}`} aria-hidden="true" />
      <span className="pl-line" title={name}>
        {name}
      </span>
    </span>
  );
}

function Meter({ row, children }: { row: WorkRow; children: ReactNode }) {
  return (
    <span className="pl-days">
      <span className="pl-bar" aria-hidden="true">
        <span
          className={`pl-bar__fill pl-bar__fill--${row.bar ?? 'normal'}`}
          style={{ width: `${Math.min(100, row.percentUsed ?? 0)}%` }}
        />
      </span>
      <span className={`pl-figure${row.overdue ? ' pl-figure--overdue' : ''}`}>{children}</span>
    </span>
  );
}

function Days({ row, today }: { row: WorkRow; today: string }) {
  const { daysInPhase: used, plannedDays: planned } = row;
  const status = unmeasuredStatus(row);
  if (status) return <span className="pl-figure">{status}</span>;
  if (row.notStarted) return row.next && <Meter row={row}>Starts {shortDate(row.next.date, today)}</Meter>;
  if (used === null) return null;
  if (!planned) {
    return <span className="pl-figure">{row.suspended ? suspendedFigure(used, true) : `${used} d in phase, no planned length`}</span>;
  }
  if (row.suspended) {
    return (
      <Meter row={row}>
        <span aria-hidden="true">{suspendedFigure(used)}</span>
        <span className="visually-hidden">{suspendedFigure(used, true)}</span>
      </Meter>
    );
  }
  return (
    <Meter row={row}>
      {used} / {planned} d{' '}
      <span className="visually-hidden">in phase{row.bar === 'near-limit' && `, ${row.percentUsed} % used`}</span>
    </Meter>
  );
}

function Next({ row, today }: { row: WorkRow; today: string }) {
  let text = 'No dated next step';
  if (row.notStarted && row.next) text = `First phase: ${row.next.name}`;
  else if (row.overdue) text = row.next ? `Blocking: ${row.next.name}` : 'Blocking the decision';
  else if (row.next) text = `Next: ${row.next.name} · ${shortDate(row.next.date, today)}`;
  return (
    <span className="pl-next">
      <span className="pl-line" title={text}>
        {text}
      </span>
      {row.suspended && (
        <span className="pill pill--neutral pl-flag">
          {row.suspendedUnder ? `Suspended ${row.suspendedUnder}` : 'Suspended'}
        </span>
      )}
    </span>
  );
}

function Card({ row, today }: { row: WorkRow; today: string }) {
  const { work } = row;
  const title = work.title || 'Untitled work';
  // Track titles already start with the project name; repeating it would only push the type off the line.
  const project = work.projectName && !title.startsWith(work.projectName) ? work.projectName : null;
  const kind = [project, work.workType ?? work.workTypeCode, work.actYear ? `${work.actYear} Act` : null].filter(Boolean);
  return (
    <li className="pl-card">
      <span className="pl-title">
        <Link className="pl-work" to={`/project-details/${encodeURIComponent(work.projectId)}`} title={title}>
          {title}
        </Link>
        {row.overdue && (
          <span className="pl-over">
            <span aria-hidden="true">+{row.daysOver}d</span>
            <span className="visually-hidden">{plural(row.daysOver, 'day')} overdue</span>
          </span>
        )}
      </span>
      {kind.length > 0 && <span className="pl-sub">{kind.join(' · ')}</span>}
      <WorkPill work={work} />
      <Phase row={row} />
      <Days row={row} today={today} />
      <Next row={row} today={today} />
    </li>
  );
}

function Column({ name, rows, today }: { name: PipelineColumn; rows: WorkRow[]; today: string }) {
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
      <div className="pl-col__head">
        <h2 className="pl-col__title" id={id}>
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
        <p className="pl-col__note">{COLUMN_NOTE[name]}</p>
      </div>
      <div className="pl-col__body">
        {rows.length === 0 ? (
          <p className="pl-empty">No works in this stage.</p>
        ) : (
          <ul className="pl-cards" ref={list}>
            {visible.map((row) => (
              <Card key={rowKey(row)} row={row} today={today} />
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

/** Open works in five stage columns by their current phase; not-started works wait in Intake. */
export function PipelineView({ rows, today, bar }: ViewProps) {
  const byColumn = useMemo(() => {
    const groups = new Map<PipelineColumn, WorkRow[]>(PIPELINE_COLUMNS.map((name) => [name, []]));
    for (const row of rows) if (row.column) groups.get(row.column)?.push(row);
    for (const group of groups.values()) group.sort(byPhaseUse);
    return groups;
  }, [rows]);

  if (rows.length === 0) {
    return (
      <div className="pl">
        {bar?.()}
        <p className="panel pl-none">No works match these filters.</p>
      </div>
    );
  }
  return (
    <div className="pl">
      {bar?.()}
      <div className="pl-board">
        {PIPELINE_COLUMNS.map((name) => (
          <Column key={name} name={name} rows={byColumn.get(name) ?? []} today={today} />
        ))}
      </div>
    </div>
  );
}
