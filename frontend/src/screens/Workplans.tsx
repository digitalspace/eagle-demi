import { useDeferredValue, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { useSearchParams } from 'react-router';
import { useProjects } from '../api/projects';
import { useWorkplans, type WorkplanRow } from '../api/sheet-works';
import { isoDay } from '../dates';
import { rowsOf, type WorkRow } from '../workplans/derive';
import { Filters, type BarSlot, type WorkFilters } from '../workplans/Filters';
import { LoadFailure, Loading } from '../workplans/LoadStates';
import { LookaheadView } from '../workplans/Lookahead';
import { Overview } from '../workplans/Overview';
import { PipelineView } from '../workplans/Pipeline';
import { Segmented } from '../workplans/Segmented';
import { StatusListView } from '../workplans/StatusList';
import { workStateOf, type WorkState } from '../workplans/work-state';
import { workTypeName } from '../workplans/work-types';
import '../workplans/workplans.css';

type View = 'timeline' | 'list' | 'pipeline' | 'lookahead';
/** The views that share the filter bar; the Timeline is the Overview, with its own controls. */
type ListView = Exclude<View, 'timeline'>;

const VIEWS: { value: View; label: string }[] = [
  { value: 'timeline', label: 'Timeline' },
  { value: 'list', label: 'List' },
  { value: 'pipeline', label: 'Pipeline' },
  { value: 'lookahead', label: 'Lookahead' },
];

const VIEW_BODY = { list: StatusListView, pipeline: PipelineView, lookahead: LookaheadView };

const NO_FILTERS: WorkFilters = {
  query: '',
  state: null,
  act: null,
  type: null,
  phase: null,
};

/** `state` undefined until the reader picks one, so each view applies its own default. */
type Draft = Omit<WorkFilters, 'state'> & { state?: WorkState | null };

/** Which filters each view applies. `defaultState` holds until the reader picks a Work state. */
const VIEW_FILTERS: Record<
  ListView,
  { states: readonly WorkState[]; defaultState: WorkState | null; phase: boolean; placeholder: boolean }
> = {
  list: { states: ['open', 'inactive', 'closed'], defaultState: 'open', phase: true, placeholder: true },
  pipeline: { states: ['open', 'inactive'], defaultState: 'open', phase: false, placeholder: true },
  // The Window toggle and Milestone type take the room "+ Filter" would need to stay on one row.
  lookahead: { states: [], defaultState: null, phase: false, placeholder: false },
};

const viewOf = (param: string | null): View => VIEWS.find((view) => view.value === param)?.value ?? 'timeline';

/** The filters `view` applies; the others stay in state, so they come back with their view. */
function appliedFilters(filters: Draft, view: ListView): WorkFilters {
  const rules = VIEW_FILTERS[view];
  const state = filters.state === undefined ? rules.defaultState : filters.state;
  return {
    ...filters,
    state: state !== null && rules.states.includes(state) ? state : null,
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
    (state !== 'closed' || states.includes('closed')) &&
    (filters.state === null || state === filters.state) &&
    (filters.act === null || row.work.actYear === filters.act) &&
    (filters.type === null || row.work.workTypeCode === filters.type) &&
    (filters.phase === null || row.current?.name === filters.phase) &&
    matchesQuery(row, filters.query)
  );
}

interface ListViewsProps {
  works: WorkplanRow[];
  view: ListView;
  today: string;
  filters: Draft;
  setFilters: Dispatch<SetStateAction<Draft>>;
}

/** The List, Pipeline and Lookahead views and their shared filter bar. */
function ListViews({ works, view, today, filters, setFilters }: ListViewsProps) {
  const projects = useProjects('');
  const projectRows = projects.data?.projects;
  const rows = useMemo(() => rowsOf(works, projectRows ?? [], today), [works, projectRows, today]);
  // Typing stays responsive: the views re-filter on the deferred copy.
  const deferred = useDeferredValue(filters);
  const applied = useMemo(() => {
    const current = appliedFilters(deferred, view);
    return { ...current, query: current.query.trim().toLowerCase() };
  }, [deferred, view]);
  const shown = useMemo(() => rows.filter((row) => matches(row, applied, VIEW_FILTERS[view].states)), [rows, applied, view]);
  // Work type and Phase offer only what Work state lets through.
  const { state } = appliedFilters(filters, view);
  const optionRows = useMemo(() => {
    const only = { ...NO_FILTERS, state };
    return rows.filter((row) => matches(row, only, VIEW_FILTERS[view].states));
  }, [rows, state, view]);

  const ViewBody = VIEW_BODY[view];
  const { states, phase, placeholder } = VIEW_FILTERS[view];
  const bar: BarSlot = (slots) => (
    <Filters
      {...slots}
      rows={optionRows}
      value={appliedFilters(filters, view)}
      onChange={(change) => setFilters((current) => ({ ...current, ...change }))}
      states={states}
      withPhase={phase}
      withPlaceholder={placeholder}
      count={shown.length}
    />
  );
  return <ViewBody rows={shown} today={today} bar={bar} />;
}

/** Every live Track and sheet work the staff reader can see, as a timeline, status list, pipeline or lookahead. */
export function Workplans() {
  const workplans = useWorkplans();
  const [params, setParams] = useSearchParams();
  // Kept here, so a picked filter survives a trip through the Timeline.
  const [filters, setFilters] = useState<Draft>({ ...NO_FILTERS, state: undefined });
  const view = viewOf(params.get('view'));
  const today = useMemo(() => isoDay(new Date().toISOString()), []);

  const changeView = (next: View) =>
    setParams((current) => {
      const updated = new URLSearchParams(current);
      updated.set('view', next);
      return updated;
    });

  let body;
  if (workplans.isPending) body = <Loading />;
  else if (workplans.isError) body = <LoadFailure error={workplans.error} />;
  else if (view === 'timeline') body = <Overview works={workplans.data} today={today} />;
  else body = <ListViews works={workplans.data} view={view} today={today} filters={filters} setFilters={setFilters} />;

  return (
    <div className={view === 'timeline' ? 'wp-page wp-page--overview' : 'wp-page'}>
      <div className="screen-header wp-header">
        <h1>Workplans</h1>
        {workplans.isSuccess && <Segmented label="View" labelHidden options={VIEWS} value={view} onChange={changeView} />}
      </div>
      {body}
    </div>
  );
}
