import { useMemo } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useWorkplans } from '../api/sheet-works';
import { isoDay } from '../dates';
import { LoadFailure, Loading } from '../workplans/LoadStates';
import { projectsOf } from '../workplans/overview-rows';
import { RecordView } from '../workplans/Record';
import { pickRecord } from '../workplans/record-header';
import { Chevron } from '../workplans/RecordChart';
import '../workplans/workplans.css';

const actParam = (value: string | null) => (value && /^\d{4}$/.test(value) ? Number(value) : null);

/** `/workplans/:projectId?act=<year>`: one project's record, read from the same cached body as the Overview. */
export function WorkplanRecord() {
  const { projectId = '' } = useParams();
  const [params] = useSearchParams();
  const workplans = useWorkplans();
  const today = useMemo(() => isoDay(new Date().toISOString()), []);
  const projects = useMemo(() => projectsOf(workplans.data ?? []), [workplans.data]);
  const pick = useMemo(() => pickRecord(projects, projectId, actParam(params.get('act'))), [projects, projectId, params]);

  if (workplans.isPending) return <Loading />;
  if (workplans.isError) return <LoadFailure error={workplans.error} />;
  if (!pick) {
    return (
      <div className="wp-rec">
        <Link className="wp-rec-back" to="/workplans">
          <Chevron d="M10 3L5 8l5 5" />
          Back to all works
        </Link>
        <h1 className="wp-rec-title">No works for project {projectId}</h1>
      </div>
    );
  }
  return <RecordView projects={projects} pick={pick} today={today} />;
}
