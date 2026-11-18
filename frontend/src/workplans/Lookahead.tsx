import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ChipSelect } from './ChipSelect';
import type { WorkRow } from './derive';
import type { ViewProps } from './Filters';
import { plural, shortDate, weekdayDate, weekOf } from './format';
import {
  MILESTONE_KINDS,
  WINDOWS,
  WINDOW_PHRASE,
  milestonesIn,
  overdueNow,
  weeksOf,
  windowEnd,
  type LookaheadWindow,
  type Milestone,
  type MilestoneKind,
  type Week,
} from './lookahead-data';
import { Segmented } from './Segmented';
import './workplans.css';
import './lookahead.css';

/** "Nov 16" whatever the year, for the histogram axis. */
const monthDay = (iso: string) => shortDate(iso, iso);
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
  return `${weekOf(week.start)}${week.current ? ' (this week)' : ''}: ${n ? plural(n, 'milestone') : 'no milestones'}${decisions}`;
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
        <span className="la-hist__hint">click a week to jump</span>
      </div>
      <ol className="la-hist__weeks" aria-labelledby={titleId}>
        {weeks.map((week, i) => {
          const n = week.milestones.length;
          const label = weekLabel(week);
          const className = `la-hist__bar${week.current ? ' la-hist__bar--current' : ''}`;
          const style = { height: `${(n / max) * 100}%` };
          return (
            <li key={week.start} className="la-hist__week">
              <span className="la-hist__plot">
                {n > 0 ? (
                  <button type="button" className={className} style={style} title={label} onClick={() => jump(week)}>
                    <span className="visually-hidden">{label}</span>
                  </button>
                ) : (
                  <span className={className} style={style}>
                    <span className="visually-hidden">{label}</span>
                  </span>
                )}
              </span>
              <span className={`la-hist__axis${i % (2 * every) ? ' la-hist__axis--minor' : ''}`} aria-hidden="true">
                {i % every === 0 ? monthDay(week.start) : ''}
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
    <li className="la-item">
      <span className="la-item__date">{weekdayDate(milestone.date)}</span>
      <span className={`la-marker la-marker--${milestone.tone}`} aria-hidden="true" />
      <span className="la-item__what" title={milestone.what}>
        {milestone.what}
      </span>
      <span className="la-item__work">
        <WorkLink row={row} />
        {row.work.projectName && <span className="la-item__project"> · {row.work.projectName}</span>}
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
              {weekOf(week.start)} <span className="la-week__count">{plural(week.milestones.length, 'milestone')}</span>
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
  const id = useId();
  return (
    <section className="panel la-panel la-panel--overdue" aria-labelledby={id}>
      <h2 id={id} className="la-panel__head">
        Overdue now <span className="la-panel__count">{rows.length.toLocaleString('en-CA')}</span>
      </h2>
      {rows.length === 0 ? (
        <p className="la-empty">No work is past the planned end of its phase.</p>
      ) : (
        <ul className="la-list la-panel__body">
          {rows.map((row) => (
            <li key={`${row.work.source}:${row.work.workId}`} className="la-list__item">
              <WorkLink row={row} />
              <span className="la-list__figure la-list__figure--overdue">
                +{row.daysOver} d<span className="visually-hidden"> over</span>
              </span>
              <span className="la-sub">
                {row.current?.name || 'Unnamed phase'}
                {row.daysInPhase !== null && row.plannedDays ? ` · ${row.daysInPhase}/${row.plannedDays} d` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DecisionsPanel({ decisions, phrase, today }: { decisions: Milestone[]; phrase: string; today: string }) {
  const id = useId();
  return (
    <section className="panel la-panel la-panel--decisions" aria-labelledby={id}>
      <h2 id={id} className="la-panel__head">
        Decisions this window
      </h2>
      {decisions.length === 0 ? (
        <p className="la-empty">No decisions in {phrase}.</p>
      ) : (
        <ul className="la-list la-panel__body">
          {decisions.map((decision) => (
            <li key={decision.key} className="la-list__item">
              <WorkLink row={decision.row} />
              <span className="la-list__figure">{shortDate(decision.date, today)}</span>
              <span className="la-sub">{decision.phase} due</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Phase starts and decisions in the next 30 days, 90 days or 6 months, by week, beside the works overdue now. */
export function LookaheadView({ rows, today, bar }: ViewProps) {
  const [span, setSpan] = useState<LookaheadWindow>('90d');
  const [kind, setKind] = useState<MilestoneKind | null>(null);
  const end = windowEnd(today, span);
  const all = useMemo(() => milestonesIn(rows, today, end), [rows, today, end]);
  const milestones = useMemo(() => (kind ? all.filter((milestone) => milestone.kind === kind) : all), [all, kind]);
  const weeks = useMemo(() => weeksOf(milestones, today, end), [milestones, today, end]);
  const overdue = useMemo(() => overdueNow(rows), [rows]);
  // The panel lists every decision in the window, whatever the Milestone type.
  const decisions = all.filter((milestone) => milestone.kind === 'decision');
  const prefix = useId();
  const idOf = (week: Week) => `${prefix}-week-${week.start}`;
  const phrase = WINDOW_PHRASE[span];
  const works = new Set(milestones.map((milestone) => milestone.row)).size;
  const range = `${shortDate(today, today)} – ${shortDate(end, today)}`;

  let empty: string | null = null;
  if (rows.length === 0) empty = 'No works match these filters.';
  else if (milestones.length === 0) {
    empty = `No milestones in ${phrase}.${span === '6m' ? '' : ' Choose a longer window to look further ahead.'}`;
  }

  const lead = <Segmented label="Window" labelHidden options={WINDOWS} value={span} onChange={setSpan} />;
  const chips = <ChipSelect label="Milestone type" options={MILESTONE_KINDS} value={kind} onChange={setKind} clearable />;
  const summary = `${milestones.length ? `${plural(milestones.length, 'milestone')} across ${plural(works, 'work')}` : 'No milestones'} · ${range}`;

  return (
    <div className="la">
      {bar?.({ lead, chips, summary })}
      <div className="la-body">
        <section className="panel la-main" aria-label="Upcoming milestones">
          {!empty && <Histogram weeks={weeks} idOf={idOf} />}
          <Agenda weeks={weeks} idOf={idOf} empty={empty} />
        </section>
        <div className="la-side">
          <OverduePanel rows={overdue} />
          <DecisionsPanel decisions={decisions} phrase={phrase} today={today} />
        </div>
      </div>
    </div>
  );
}
