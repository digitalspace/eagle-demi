import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ApiError, errorMessage } from '../api/client';
import { useProjects } from '../api/projects';
import { useWorkplans } from '../api/sheet-works';
import { isoDay } from '../dates';
import { rowsOf, type WorkRow } from '../workplans/derive';
import { Filters, type WorkFilters } from '../workplans/Filters';
import { LookaheadView } from '../workplans/Lookahead';
import { PipelineView } from '../workplans/Pipeline';
import { Segmented } from '../workplans/Segmented';
import { StatusListView } from '../workplans/StatusList';
import { TimelineView } from '../workplans/Timeline';
import '../workplans/workplans.css';

type View = 'timeline' | 'list' | 'pipeline' | 'lookahead';

const VIEWS: { value: View; label: string }[] = [
  { value: 'timeline', label: 'Timeline' },
  { value: 'list', label: 'List' },
  { value: 'pipeline', label: 'Pipeline' },
  { value: 'lookahead', label: 'Lookahead' },
];

const VIEW_BODY = { timeline: TimelineView, list: StatusListView, pipeline: PipelineView, lookahead: LookaheadView };

const NO_FILTERS: WorkFilters = { act: null, type: null, status: null, showHidden: false };

const viewOf = (param: string | null): View => VIEWS.find((view) => view.value === param)?.value ?? 'timeline';

/** `status` is null outside the timeline: the other views leave closed works out or filter status themselves. */
function matches(row: WorkRow, filters: WorkFilters, status: WorkFilters['status']): boolean {
  return (
    (filters.showHidden || row.work.shownAfterFlip !== false) &&
    (filters.act === null || row.work.actYear === filters.act) &&
    (filters.type === null || row.work.workTypeCode === filters.type) &&
    (status === null || row.status === status)
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
  // Kept in state in the other views, so going back to the timeline restores the chosen status.
  const withStatus = view === 'timeline';
  const status = withStatus ? filters.status : null;
  const shown = useMemo(() => rows.filter((row) => matches(row, filters, status)), [rows, filters, status]);

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
    body = (
      <>
        <Filters rows={rows} value={filters} onChange={setFilters} withStatus={withStatus} />
        <ViewBody rows={shown} today={today} />
      </>
    );
  }

  return (
    <div className="wp-page">
      <div className="screen-header">
        <div className="screen-header__text">
          <h1>Workplans</h1>
          <p>Live works from Track and the business spreadsheets, as they stand today.</p>
        </div>
        {workplans.isSuccess && <Segmented label="View" options={VIEWS} value={view} onChange={changeView} />}
      </div>
      {body}
    </div>
  );
}
