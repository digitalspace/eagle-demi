import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { dayMonthYear } from '../dates';
import type { WorkRow } from './derive';
import {
  WINDOWS,
  WINDOW_PHRASE,
  milestonesIn,
  overdueNow,
  weeksOf,
  windowEnd,
  type LookaheadWindow,
  type Milestone,
  type Week,
} from './lookahead-data';
import { Segmented } from './Segmented';
import { dayNumber } from './timeline-scale';
import './workplans.css';
import './lookahead.css';

const OVERDUE_CAP = 8;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-CA')} ${n === 1 ? one : many}`;
/** "5 Dec" */
const dayMon = (iso: string) => dayMonthYear(iso).replace(/ \d{4}$/, '');
/** "Sat 5 Dec" */
const weekdayDayMon = (iso: string) => `${WEEKDAYS[(dayNumber(iso) + 3) % 7]} ${dayMon(iso)}`;
const inDays = (n: number) => (n === 0 ? 'today' : `in ${n} d`);
const workPath = (row: WorkRow) => `/project-details/${encodeURIComponent(row.work.projectId)}`;

function WorkLink({ row }: { row: WorkRow }) {
  const title = row.work.title || 'Untitled work';
  return (
    <Link className="la-work" to={workPath(row)} title={title}>
      {title}
    </Link>
  );
}

function weekLabel(week: Week) {
  const n = week.milestones.length;
  const decisions = week.decisions ? `, ${plural(week.decisions, 'decision')}` : '';
  return `Week of ${dayMon(week.start)}${week.current ? ' (this week)' : ''}: ${n ? plural(n, 'milestone') : 'no milestones'}${decisions}`;
}

function Histogram({ weeks, idOf }: { weeks: Week[]; idOf: (week: Week) => string }) {
  const max = Math.max(1, ...weeks.map((week) => week.milestones.length));
  // Every k-th week carries a date, so labels never crowd at six months; narrow screens drop every other one.
  const every = Math.ceil(weeks.length / 7);
  const jump = (week: Week) => document.getElementById(idOf(week))?.focus();
  const titleId = useId();
  return (
    <div className="la-hist">
      <div className="la-hist__head">
        <h2 id={titleId} className="la-hist__title">
          Milestones per week
        </h2>
        <ul className="la-legend" aria-label="Legend">
          <li>
            <span className="la-legend__swatch la-bar--phase" aria-hidden="true" />
            Phase starts
          </li>
          <li>
            <span className="la-legend__swatch la-bar--decision" aria-hidden="true" />
            Decisions
          </li>
        </ul>
      </div>
      <ol className={`la-hist__weeks${weeks.length > 14 ? ' la-hist__weeks--dense' : ''}`} aria-labelledby={titleId}>
        {weeks.map((week, i) => {
          const n = week.milestones.length;
          const label = weekLabel(week);
          const plot = (
            <>
              <span className="la-hist__count" aria-hidden="true">
                {n || ''}
              </span>
              <span className="la-hist__stack" style={{ height: `${(n / max) * 100}%` }} aria-hidden="true">
                {week.decisions > 0 && <span className="la-bar--decision" style={{ flexGrow: week.decisions }} />}
                {n > week.decisions && <span className="la-bar--phase" style={{ flexGrow: n - week.decisions }} />}
              </span>
              <span className="visually-hidden">{label}</span>
            </>
          );
          return (
            <li key={week.start} className={`la-hist__week${week.current ? ' la-hist__week--current' : ''}`}>
              {n > 0 ? (
                <button type="button" className="la-hist__plot" title={label} onClick={() => jump(week)}>
                  {plot}
                </button>
              ) : (
                <span className="la-hist__plot">{plot}</span>
              )}
              <span className={`la-hist__axis${i % (2 * every) ? ' la-hist__axis--minor' : ''}`} aria-hidden="true">
                {week.current ? 'This week' : i % every === 0 ? dayMon(week.start) : ''}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function AgendaItem({ milestone }: { milestone: Milestone }) {
  const { row } = milestone;
  return (
    <li className={`la-item la-item--${milestone.kind}`}>
      <span className="la-item__date">{weekdayDayMon(milestone.date)}</span>
      <span className={`la-marker la-marker--${milestone.kind}`} aria-hidden="true" />
      <span className="la-item__what">{milestone.what}</span>
      <span className="la-item__work">
        <WorkLink row={row} />
        {row.work.projectName && <span className="la-sub">{row.work.projectName}</span>}
      </span>
      <span className="la-item__in">{inDays(milestone.inDays)}</span>
    </li>
  );
}

function Agenda({ weeks, idOf, empty }: { weeks: Week[]; idOf: (week: Week) => string; empty: string | null }) {
  if (empty) return <p className="la-empty">{empty}</p>;
  return (
    <div className="la-agenda">
      {weeks
        .filter((week) => week.milestones.length > 0)
        .map((week) => (
          <section key={week.start} className="la-week" aria-labelledby={idOf(week)}>
            <h3 id={idOf(week)} className="la-week__head" tabIndex={-1}>
              <span className="la-week__range">
                {dayMon(week.start)} – {dayMon(week.end)}
              </span>
              {week.current && <span className="la-week__now">This week</span>}
              <span className="la-week__count">{plural(week.milestones.length, 'milestone')}</span>
            </h3>
            <ul className="la-week__items">
              {week.milestones.map((milestone) => (
                <AgendaItem key={milestone.key} milestone={milestone} />
              ))}
            </ul>
          </section>
        ))}
    </div>
  );
}

function OverduePanel({ rows }: { rows: WorkRow[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, OVERDUE_CAP);
  const id = useId();
  return (
    <section className="panel la-panel la-panel--overdue" aria-labelledby={id}>
      <h2 id={id} className="la-panel__head">
        Overdue now <span className="la-panel__count">{rows.length.toLocaleString('en-CA')}</span>
      </h2>
      {rows.length === 0 ? (
        <p className="la-empty">No work is past the planned end of its phase.</p>
      ) : (
        <div className="la-panel__body">
          <ul className="la-list">
            {shown.map((row) => (
              <li key={`${row.work.source}:${row.work.workId}`} className="la-list__item">
                <WorkLink row={row} />
                <span className="la-list__figure la-list__figure--overdue">
                  +{row.daysOver} d<span className="visually-hidden"> over</span>
                </span>
                <span className="la-sub">
                  {row.current?.name || 'Unnamed phase'}
                  {row.daysInPhase !== null && row.plannedDays ? ` · ${row.daysInPhase} of ${row.plannedDays} d` : ''}
                </span>
              </li>
            ))}
          </ul>
          {rows.length > shown.length && (
            <button type="button" className="la-more" onClick={() => setAll(true)}>
              Show {rows.length - shown.length} more
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function DecisionsPanel({ decisions, phrase }: { decisions: Milestone[]; phrase: string }) {
  const id = useId();
  return (
    <section className="panel la-panel la-panel--decisions" aria-labelledby={id}>
      <h2 id={id} className="la-panel__head">
        Decisions this window <span className="la-panel__count">{decisions.length.toLocaleString('en-CA')}</span>
      </h2>
      {decisions.length === 0 ? (
        <p className="la-empty">No decisions in {phrase}.</p>
      ) : (
        <ul className="la-list la-panel__body">
          {decisions.map((decision) => (
            <li key={decision.key} className="la-list__item">
              <WorkLink row={decision.row} />
              <span className="la-list__figure">{dayMon(decision.date)}</span>
              <span className="la-sub">
                {decision.what}, {inDays(decision.inDays)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Phase starts and decisions in the next 30 days, 90 days or 6 months, by week, beside the works overdue now. */
export function LookaheadView({ rows, today }: { rows: WorkRow[]; today: string }) {
  const [span, setSpan] = useState<LookaheadWindow>('90d');
  const end = windowEnd(today, span);
  const milestones = useMemo(() => milestonesIn(rows, today, end), [rows, today, end]);
  const weeks = useMemo(() => weeksOf(milestones, today, end), [milestones, today, end]);
  const overdue = useMemo(() => overdueNow(rows), [rows]);
  const decisions = milestones.filter((milestone) => milestone.kind === 'decision');
  const prefix = useId();
  const idOf = (week: Week) => `${prefix}-week-${week.start}`;
  const phrase = WINDOW_PHRASE[span];
  const works = new Set(milestones.map((milestone) => milestone.row)).size;
  const range = `${dayMonthYear(today)} to ${dayMonthYear(end)}`;

  let empty: string | null = null;
  if (rows.length === 0) empty = 'No works match these filters.';
  else if (milestones.length === 0) {
    empty = `No milestones in ${phrase}.${span === '6m' ? '' : ' Choose a longer window to look further ahead.'}`;
  }

  return (
    <div className="la">
      <div className="la-toolbar">
        <Segmented label="Window" options={WINDOWS} value={span} onChange={setSpan} />
        <p className="la-summary" role="status">
          {milestones.length ? `${plural(milestones.length, 'milestone')} across ${plural(works, 'work')}` : 'No milestones'},{' '}
          {range}
        </p>
      </div>
      <div className="la-body">
        <section className="panel la-main" aria-label="Upcoming milestones">
          {!empty && <Histogram weeks={weeks} idOf={idOf} />}
          <Agenda weeks={weeks} idOf={idOf} empty={empty} />
        </section>
        <div className="la-side">
          <OverduePanel rows={overdue} />
          <DecisionsPanel decisions={decisions} phrase={phrase} />
        </div>
      </div>
    </div>
  );
}
