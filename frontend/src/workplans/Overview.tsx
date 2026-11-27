import { startTransition, useCallback, useId, useLayoutEffect, useMemo, useOptimistic, useRef, useState } from 'react';
import { AssignedFields, type People } from './AssignedFields';
import { peopleOf } from './assigned';
import { useLocation } from 'react-router';
import type { WorkplanRow } from '../api/sheet-works';
import type { ActYear, WorkKind } from './chart-facts';
import { count } from './format';
import { useMarkTip, type MarkTipControl } from './MarkTip';
import { rowId } from './overview-chips';
import { ROW_STATES, SORTS, WORK_KINDS, type FilterCounts, type SortKey } from './overview-rows';
import { OverviewAct } from './OverviewAct';
import { OverviewKey } from './OverviewKey';
import { Segmented } from './Segmented';
import { TimeScale } from './TimeScale';
import type { Zoom } from './time-scale';
import { useOverviewActs, type OverviewActData } from './use-overview-acts';
import { useOverviewParams, type OverviewParams } from './use-overview-params';
import { useOverviewScroll, type ScrollTo } from './use-overview-scroll';
import './chart-controls.css';
import './overview.css';

type Change = (change: Partial<OverviewParams>) => void;

/** A change to these clears the status line; sort and zoom leave it. */
const FILTER_PARAMS: readonly (keyof OverviewParams)[] = ['q', 'off', 'state', 'phase', 'over', 'who', 'team'];

/** What each Act section shares with the page: the one tooltip, its rows box, scrolling, the status line and the params. */
export interface OverviewShared {
  tip: Pick<MarkTipControl, 'hitTest' | 'hide' | 'hideSoon'>;
  today: string;
  closed: ReadonlySet<ActYear>;
  setOpen: (year: ActYear, open: boolean) => void;
  /** Jumps to the project's row under `year`: opens that Act, clears the filters that hide the row, focuses its name. */
  goRow: (year: ActYear, projectId: string) => void;
  register: (year: ActYear, box: HTMLElement | null) => void;
  scroll: (how: ScrollTo, only?: ActYear) => void;
  /** Writes the nav's status line, such as what a cross-Act link cleared. */
  say: (text: string) => void;
  params: OverviewParams;
  change: Change;
}

function SearchBand({ text, sort, change }: { text: string; sort: SortKey; change: Change }) {
  const findId = useId();
  const sortId = useId();
  const sortLabel = SORTS.find(([key]) => key === sort)?.[1] ?? SORTS[0][1];
  return (
    <div className="wp-ov-band" role="search" aria-label="Search projects">
      <div className="wp-ov-fld wp-ov-fld--find">
        <label className="wp-ov-tlab" htmlFor={findId}>
          Search
        </label>
        <div className="wp-field">
          <svg className="wp-field__icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L14 14" />
          </svg>
          <input
            id={findId}
            className="wp-field__input"
            type="search"
            autoComplete="off"
            placeholder="Project or work name, or ID"
            value={text}
            onChange={(event) => change({ q: event.target.value })}
          />
        </div>
      </div>
      <div className="wp-ov-fld wp-ov-fld--pick">
        <label className="wp-ov-tlab" htmlFor={sortId}>
          Sort by
        </label>
        <select
          id={sortId}
          className="wp-dsel"
          value={sort}
          title={`Sort by: ${sortLabel}`}
          onChange={(event) => change({ sort: event.target.value as SortKey })}
        >
          {SORTS.map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function FilterBand({ params, counts, change, people }: { params: OverviewParams; counts: FilterCounts; change: Change; people: People }) {
  const kindId = useId();
  const phaseId = useId();
  const onlyId = useId();
  // The URL change runs in a transition; without this the box shows unchecked until it lands.
  const [over, setOver] = useOptimistic(params.over);
  const setOverNow = (on: boolean) =>
    startTransition(() => {
      setOver(on);
      change({ over: on });
    });
  const toggleKind = (kind: WorkKind) => {
    const off = new Set(params.off);
    if (!off.delete(kind)) off.add(kind);
    change({ off });
  };
  const phaseLabel = params.phase || 'Any';
  const states = ROW_STATES.map(([value, label]) => ({
    value,
    label: (
      <>
        {label}
        <span className="wp-qn">{count(counts.states[value])}</span>
      </>
    ),
  }));
  const said = ROW_STATES.map(([value, label]) => `${label} ${count(counts.states[value])}`).join(', ');
  return (
    <div className="wp-ov-band wp-ov-band--filt" role="group" aria-label="Filter">
      <div className="wp-ov-fld">
        <span className="wp-ov-tlab" id={kindId}>
          Work type
        </span>
        <div className="wp-tgroup" role="group" aria-labelledby={kindId}>
          {WORK_KINDS.map(([kind, label]) => (
            <button key={kind} type="button" className="wp-tbtn" aria-pressed={!params.off.has(kind)} onClick={() => toggleKind(kind)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="wp-ov-fld">
        <Segmented label="State" radio options={states} value={params.state} onChange={(state) => change({ state })} />
      </div>
      <div className="wp-ov-fld wp-ov-fld--pick">
        <label className="wp-ov-tlab" htmlFor={phaseId}>
          Phase
        </label>
        <select id={phaseId} className="wp-dsel" value={params.phase} title={`Phase: ${phaseLabel}`} onChange={(event) => change({ phase: event.target.value })}>
          <option value="">Any</option>
          {/* A phase picked from the URL stays offered even when no row has it. */}
          {[...new Set([...counts.phases, ...(params.phase ? [params.phase] : [])])].sort().map((phase) => (
            <option key={phase} value={phase}>
              {phase}
            </option>
          ))}
        </select>
      </div>
      <AssignedFields who={params.who} team={params.team} people={people} change={change} />
      <div className="wp-ov-fld">
        <span className="wp-ov-tlab" id={onlyId}>
          Show only
        </span>
        <div className="wp-ov-fgrp" role="group" aria-labelledby={onlyId}>
          <label className="wp-ov-check">
            <input type="checkbox" checked={over} onChange={(event) => setOverNow(event.target.checked)} />
            Over a time limit <span className="wp-qn">{count(counts.over)}</span>
          </label>
        </div>
      </div>
      <p className="visually-hidden" aria-live="polite">
        {`State: ${said}. Over a time limit ${count(counts.over)}.`}
      </p>
    </div>
  );
}

interface NavProps {
  acts: readonly OverviewActData[];
  zoom: Zoom;
  onZoom: (zoom: Zoom) => void;
  onToday: () => void;
  year: string;
  onYear: (year: number | null) => void;
  flash: string;
}

function OverviewNav({ acts, zoom, onZoom, onToday, year, onYear, flash }: NavProps) {
  const gotoId = useId();
  const dated = acts.flatMap((act) => (act.axis ? [act.axis] : []));
  const first = Math.min(...dated.map((axis) => axis.y0));
  const last = Math.max(...dated.map((axis) => axis.y0 + axis.years));
  const years = dated.length ? Array.from({ length: last - first }, (_, i) => first + i) : [];
  return (
    <nav className="wp-ov-vbar" aria-label="Navigate the timeline">
      <div className="wp-ov-fld" role="group" aria-labelledby={gotoId}>
        <span className="wp-ov-tlab" id={gotoId}>
          Jump to
        </span>
        <div className="wp-ov-fgrp">
          {acts.map((act) => (
            <a key={act.year} className="wp-btn wp-btn--secondary" href={`#act-${act.year}`}>
              {act.year} Act
            </a>
          ))}
        </div>
      </div>
      <span className="wp-ov-vsep" aria-hidden="true" />
      <TimeScale layout="stacked" zoom={zoom} onZoom={onZoom} onToday={onToday} year={{ years, value: year, onChange: onYear }} />
      <p className={flash ? 'wp-ov-flash' : 'wp-ov-flash visually-hidden'} role="status">
        {flash}
      </p>
    </nav>
  );
}

/** A row to focus once it is drawn; `tries` counts redraws without it. */
interface RowGoal {
  id: string;
  tries: number;
}

const arrivalRow = (state: unknown): RowGoal | null => {
  const id = (state as { rowId?: unknown } | null)?.rowId;
  return typeof id === 'string' ? { id, tries: 0 } : null;
};

function focusRow(id: string): boolean {
  const link = document.getElementById(id)?.querySelector<HTMLElement>('.wp-ov-nm');
  if (!link) return false;
  link.scrollIntoView({ block: 'center' });
  link.focus({ preventScroll: true });
  // Marks the row a jump link or a return from a record lands on; the class restarts when the same row is hit again.
  const row = document.getElementById(id);
  if (row) {
    row.classList.remove('wp-ov-rw--lit');
    void row.offsetWidth;
    row.classList.add('wp-ov-rw--lit');
    window.setTimeout(() => row.classList.remove('wp-ov-rw--lit'), 4000);
  }
  return true;
}

const SHOW_EVERY_ROW: Partial<OverviewParams> = { q: '', off: new Set(), state: 'any', phase: '', over: false, who: '', team: '' };

/** All works by Act: search and filters, the sticky time scale bar, then one section per Act. */
export function Overview({ works, today }: { works: readonly WorkplanRow[]; today: string }) {
  const [params, update] = useOverviewParams();
  const { rootRef, tooltip, hitTest, hide, hideSoon } = useMarkTip({ delegate: '.wp-ov-mk' });
  const { trackPx, register, centres, scroll } = useOverviewScroll(rootRef);
  const { acts, counts } = useOverviewActs(works, today, params, trackPx);
  const people = useMemo(() => peopleOf(works), [works]);
  // Local copy: router updates run in a transition, and a text box bound to one drops keystrokes.
  const [text, setText] = useState(params.q);
  const [flash, setFlash] = useState('');
  const flashFrame = useRef(0);
  const [year, setYear] = useState('');
  // A first load at a zoom level opens like a zoom from the whole range.
  const pending = useRef<ScrollTo | null>(params.zoom === 'whole' ? null : { to: 'open' });
  const location = useLocation();
  const [closed, setClosed] = useState<ReadonlySet<ActYear>>(() => new Set());
  // Back from a record: its row once, on the first draw.
  const goal = useRef<RowGoal | null>(arrivalRow(location.state));

  const change = useCallback<Change>(
    (next) => {
      if (next.q !== undefined) setText(next.q);
      if (FILTER_PARAMS.some((key) => next[key] !== undefined)) setFlash('');
      hide();
      update(next);
    },
    [update, hide],
  );

  const scrollActs = useCallback((how: ScrollTo, only?: ActYear) => scroll(how, acts, only), [scroll, acts]);

  // From the whole range a zoom opens each Act on today or its latest date; between levels it keeps the centre date.
  const setZoom = (zoom: Zoom, then?: ScrollTo) => {
    if (zoom === params.zoom) {
      if (then) scrollActs(then);
      return;
    }
    const from = params.zoom;
    pending.current = then ?? (zoom === 'whole' ? null : from === 'whole' ? { to: 'open' } : { to: 'centre', at: centres() });
    change({ zoom });
  };

  // Runs once the new zoom is drawn, so the boxes have their new widths.
  useLayoutEffect(() => {
    const how = pending.current;
    if (!how) return;
    pending.current = null;
    scroll(how, acts);
  }, [acts, scroll]);

  const onYear = (picked: number | null) => {
    setYear(picked ? String(picked) : '');
    if (!picked) return;
    // An Act with no dates in the picked year cannot scroll to it: say so, since it stays where its dates are.
    const out = acts.flatMap((act) => {
      const { axis } = act;
      if (!axis || closed.has(act.year) || (picked >= axis.y0 && picked < axis.y0 + axis.years)) return [];
      return [`${act.year} Act (${axis.y0} to ${axis.y0 + axis.years - 1})`];
    });
    // Cleared first, so the same message picked twice is announced again.
    setFlash('');
    cancelAnimationFrame(flashFrame.current);
    if (out.length) {
      const text = `No dates in ${picked} under the ${out.join(' or the ')}`;
      flashFrame.current = requestAnimationFrame(() => setFlash(text));
    }
    const how: ScrollTo = { to: 'year', year: picked };
    if (params.zoom === 'whole') setZoom('5', how);
    else scrollActs(how);
  };

  const setOpen = useCallback((year: ActYear, open: boolean) => {
    setClosed((was) => {
      const next = new Set(was);
      if (open) next.delete(year);
      else next.add(year);
      return next;
    });
  }, []);

  const goRow = useCallback(
    (year: ActYear, projectId: string) => {
      const id = rowId(year, projectId);
      if (focusRow(id)) return;
      goal.current = { id, tries: 0 };
      setOpen(year, true);
      const act = acts.find((a) => a.year === year);
      if (act?.rows.some((row) => row.cand.row.project.projectId === projectId)) return;
      change(SHOW_EVERY_ROW);
      setFlash('Filters cleared to show this row');
    },
    [acts, change, setOpen],
  );

  // The search filter runs on a deferred copy, so a cleared filter can take more than one draw to bring the row.
  useLayoutEffect(() => {
    const want = goal.current;
    if (want && (focusRow(want.id) || ++want.tries > 3)) goal.current = null;
  }, [acts, closed]);

  const shared: OverviewShared = {
    tip: { hitTest, hide, hideSoon },
    today,
    closed,
    setOpen,
    goRow,
    register,
    scroll: scrollActs,
    say: setFlash,
    params,
    change,
  };

  return (
    <div className="wp-ov" ref={rootRef}>
      <p className="wp-ov-lead">All works by Act. Select a project to open its record.</p>
      <section className="wp-ov-tools" aria-label="Search and filter">
        <SearchBand text={text} sort={params.sort} change={change} />
        <FilterBand params={params} counts={counts} change={change} people={people} />
      </section>
      <OverviewNav
        acts={acts}
        zoom={params.zoom}
        onZoom={(zoom) => setZoom(zoom)}
        onToday={() => scrollActs({ to: 'today' })}
        year={year}
        onYear={onYear}
        flash={flash}
      />
      {acts.map((act) => (
        <OverviewAct key={act.year} act={act} shared={shared} />
      ))}
      <OverviewKey />
      {tooltip}
    </div>
  );
}
