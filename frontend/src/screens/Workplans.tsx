import { useDeferredValue, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ApiError, errorMessage } from '../api/client';
import { useProjects } from '../api/projects';
import { useWorkplans } from '../api/sheet-works';
import { isoDay } from '../dates';
import { rowsOf, type WorkRow } from '../workplans/derive';
import { Filters, type BarSlot, type WorkFilters } from '../workplans/Filters';
import { LookaheadView } from '../workplans/Lookahead';
import { PipelineView } from '../workplans/Pipeline';
import { Segmented } from '../workplans/Segmented';
import { StatusListView } from '../workplans/StatusList';
import { TimelineView } from '../workplans/Timeline';
import { workStateOf, type WorkState } from '../workplans/work-state';
import { workTypeName } from '../workplans/work-types';
import '../workplans/workplans.css';

type View = 'timeline' | 'list' | 'pipeline' | 'lookahead';

const VIEWS: { value: View; label: string }[] = [
  { value: 'timeline', label: 'Timeline' },
  { value: 'list', label: 'List' },
  { value: 'pipeline', label: 'Pipeline' },
  { value: 'lookahead', label: 'Lookahead' },
];

const VIEW_BODY = { timeline: TimelineView, list: StatusListView, pipeline: PipelineView, lookahead: LookaheadView };

const NO_FILTERS: WorkFilters = {
  query: '',
  state: 'open',
  act: null,
  type: null,
  status: null,
  phase: null,
  showHidden: false,
};

/** Which filters each view applies. */
const VIEW_FILTERS: Record<View, { states: readonly WorkState[]; status: boolean; phase: boolean }> = {
  timeline: { states: ['open', 'inactive', 'closed'], status: true, phase: false },
  list: { states: ['open', 'inactive', 'closed'], status: false, phase: true },
  pipeline: { states: ['open', 'inactive'], status: false, phase: false },
  lookahead: { states: [], status: false, phase: false },
};

const viewOf = (param: string | null): View => VIEWS.find((view) => view.value === param)?.value ?? 'timeline';

/** The filters `view` applies; the others stay in state, so they come back with their view. */
function appliedFilters(filters: WorkFilters, view: View): WorkFilters {
  const rules = VIEW_FILTERS[view];
  return {
    ...filters,
    state: filters.state !== null && rules.states.includes(filters.state) ? filters.state : null,
    status: rules.status ? filters.status : null,
    phase: rules.phase ? filters.phase : null,
  };
}

/** `query` already trimmed and lower case. */
const matchesQuery = (row: WorkRow, query: string) =>
  !query ||
  [row.work.title, row.work.projectName, workTypeName(row.work.workTypeCode)].some((text) =>
    (text ?? '').toLowerCase().includes(query),
  );

/** `states` are the ones the view shows at all: a view without Closed never gets a closed work. */
function matches(row: WorkRow, filters: WorkFilters, states: readonly WorkState[]): boolean {
  const state = workStateOf(row);
  return (
    (filters.showHidden || row.work.shownAfterFlip !== false) &&
    (state !== 'closed' || states.includes('closed')) &&
    (filters.state === null || state === filters.state) &&
    (filters.act === null || row.work.actYear === filters.act) &&
    (filters.type === null || row.work.workTypeCode === filters.type) &&
    (filters.status === null || row.status === filters.status) &&
    (filters.phase === null || row.current?.name === filters.phase) &&
    matchesQuery(row, filters.query)
  );
}

/** 404 and 403 are expected here: the route is served on dev and test only, and to staff only. */
function LoadFailure({ error }: { error: Error }) {
  const status = error instanceof ApiError ? error.status : null;
  if (status === 404 || status === 403) {
    return (
      <div className="callout" role="status">
        <p>
          {status === 404
            ? 'Workplans are served on dev and test only.'
            : 'Only staff can see the workplans. Sign in with an IDIR account to see them.'}
        </p>
      </div>
    );
  }
  return (
    <div className="callout callout--warning" role="alert">
      <p>{errorMessage(error)}</p>
    </div>
  );
}

function Loading() {
  return (
    <section className="panel panel--padded wp-page__loading" aria-busy="true">
      <span className="visually-hidden">Loading workplans…</span>
      {[60, 45, 70, 50].map((width) => (
        <span key={width} className="skeleton skeleton--text" style={{ width: `${width}%` }} aria-hidden="true" />
      ))}
    </section>
  );
}

/** Every live Track and sheet work the staff reader can see, as a timeline, status list, pipeline or lookahead. */
export function Workplans() {
  const workplans = useWorkplans();
  const projects = useProjects('');
  const [params, setParams] = useSearchParams();
  const [filters, setFilters] = useState<WorkFilters>(NO_FILTERS);
  const view = viewOf(params.get('view'));
  const today = useMemo(() => isoDay(new Date().toISOString()), []);

  const projectRows = projects.data?.projects;
  const rows = useMemo(
    () => (workplans.data ? rowsOf(workplans.data, projectRows ?? [], today) : []),
    [workplans.data, projectRows, today],
  );
  // Typing stays responsive: the views re-filter on the deferred copy.
  const deferred = useDeferredValue(filters);
  const shown = useMemo(() => {
    const applied = appliedFilters(deferred, view);
    const query = applied.query.trim().toLowerCase();
    return rows.filter((row) => matches(row, { ...applied, query }, VIEW_FILTERS[view].states));
  }, [rows, deferred, view]);

  const changeView = (next: View) =>
    setParams((current) => {
      const updated = new URLSearchParams(current);
      updated.set('view', next);
      return updated;
    });

  let body;
  if (workplans.isPending) body = <Loading />;
  else if (workplans.isError) body = <LoadFailure error={workplans.error} />;
  else {
    const ViewBody = VIEW_BODY[view];
    const { states, status, phase } = VIEW_FILTERS[view];
    const bar: BarSlot = (slots) => (
      <Filters
        rows={rows}
        value={appliedFilters(filters, view)}
        onChange={(change) => setFilters((current) => ({ ...current, ...change }))}
        states={states}
        withStatus={status}
        withPhase={phase}
        count={shown.length}
        lead={slots?.lead}
        summary={slots?.summary}
      />
    );
    body = <ViewBody rows={shown} today={today} bar={bar} />;
  }

  return (
    <div className="wp-page">
      <div className="screen-header wp-header">
        <h1>Workplans</h1>
        {workplans.isSuccess && <Segmented label="View" labelHidden options={VIEWS} value={view} onChange={changeView} />}
      </div>
      {body}
    </div>
  );
}
