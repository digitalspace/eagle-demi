import { Link } from 'react-router';
import { useProjects } from '../api/projects';
import { useSheetWorks, type WorkplanRow } from '../api/sheet-works';
import { dayMonthYear } from '../dates';
import { SheetWorkRow } from '../screens/SheetWorksPanel';
import type { WorkRow } from './derive';
import { projectDetailsPath } from './work-notes';
import './workplans.css';

const CERTIFICATE = {
  PAC: 'Project Approval Certificate (PAC)',
  EAC: 'Environmental Assessment Certificate (EAC)',
} as const;

const COMPLEXITY = { 'pre-2014': 'Pre-2014', simple: 'Simple', typical: 'Typical', complex: 'Complex' } as const;

function movedIn(work: WorkplanRow): string | null {
  const from = work.transitionIn;
  if (!from) return null;
  const date = dayMonthYear(from.date);
  return `Moved from ${from.fromActYear ? `the ${from.fromActYear} Act` : 'an earlier Act'}${date ? ` on ${date}` : ''}`;
}

function SheetBody({ row }: { row: WorkRow }) {
  const { projectId, workId } = row.work;
  const { data: works, isLoading } = useSheetWorks(projectId);
  if (isLoading) {
    return (
      <div className="wp-details__loading" aria-busy="true">
        <p className="visually-hidden">Loading details…</p>
        <span className="skeleton skeleton--text" aria-hidden="true" style={{ width: '18rem' }} />
        <span className="skeleton skeleton--text" aria-hidden="true" style={{ width: '24rem' }} />
        <span className="skeleton skeleton--text" aria-hidden="true" style={{ width: '14rem' }} />
      </div>
    );
  }
  const work = works?.find((sheet) => sheet.workId === workId);
  if (!work) {
    return (
      <p className="ps-note wp-details__note">
        Details are not available. <Link to={projectDetailsPath(projectId)}>Open the project page</Link>
      </p>
    );
  }
  return (
    <ul className="ps-list">
      <SheetWorkRow work={work} />
    </ul>
  );
}

/** A sheet work's stored phases, milestones and interruptions, under facts the Workplans row does not show. */
export function WorkDetails({ row, id }: { row: WorkRow; id: string }) {
  const { work } = row;
  const { data } = useProjects('');
  const project = data?.projects.find((candidate) => String(candidate.id) === work.projectId);
  const facts = [
    work.certificateKind && CERTIFICATE[work.certificateKind],
    work.complexityCode && `Complexity: ${COMPLEXITY[work.complexityCode]}`,
    movedIn(work),
    project?.region && `Region: ${project.region}`,
    project?.proponent && `Proponent: ${project.proponent}`,
  ].filter(Boolean);
  return (
    <section id={id} className="wp-details" aria-label={work.title || 'Untitled work'}>
      {facts.length > 0 && <p className="wp-details__facts">{facts.join(' · ')}</p>}
      <SheetBody row={row} />
    </section>
  );
}
