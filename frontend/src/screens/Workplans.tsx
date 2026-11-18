import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ApiError, errorMessage } from '../api/client';
import { useProjects } from '../api/projects';
import { useWorkplans } from '../api/sheet-works';
import { isoDay } from '../dates';
import { rowsOf, type WorkRow } from '../workplans/derive';
import { Filters, type WorkFilters } from '../workplans/Filters';
import { StatusListView } from '../workplans/StatusList';
import { TimelineView } from '../workplans/Timeline';
import '../workplans/workplans.css';

type View = 'timeline' | 'list';

const VIEWS: { value: View; label: string }[] = [
  { value: 'timeline', label: 'Timeline' },
  { value: 'list', label: 'List' },
];

const NO_FILTERS: WorkFilters = { act: null, type: null, status: null, showHidden: false };

const viewOf = (param: string | null): View => (param === 'list' ? 'list' : 'timeline');

function matches(row: WorkRow, filters: WorkFilters): boolean {
  return (
    (filters.showHidden || row.work.shownAfterFlip !== false) &&
    (filters.act === null || row.work.actYear === filters.act) &&
    (filters.type === null || row.work.workTypeCode === filters.type) &&
    (filters.status === null || row.status === filters.status)
  );
}

function ViewSwitch({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  return (
    <div className="wp-views" role="group" aria-label="View">
      {VIEWS.map((option) => (
        <button
          key={option.value}
          type="button"
          className="wp-views__option"
          aria-pressed={option.value === view}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
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

/** Every live Track and sheet work the staff reader can see, as a timeline or a status list. */
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
  const shown = useMemo(() => rows.filter((row) => matches(row, filters)), [rows, filters]);

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
    body = (
      <>
        <Filters rows={rows} value={filters} onChange={setFilters} />
        {view === 'list' ? <StatusListView rows={shown} today={today} /> : <TimelineView rows={shown} today={today} />}
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
        {workplans.isSuccess && <ViewSwitch view={view} onChange={changeView} />}
      </div>
      {body}
    </div>
  );
}
