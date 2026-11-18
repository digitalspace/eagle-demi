import { Link } from 'react-router';
import { useProjects } from '../api/projects';
import { useSheetWorks, type SheetWork } from '../api/sheet-works';
import { SheetWorkRow } from '../screens/SheetWorksPanel';
import type { WorkRow } from './derive';
import { movedText, projectDetailsPath } from './work-notes';
import './workplans.css';

const CERTIFICATE = {
  PAC: 'Project Approval Certificate (PAC)',
  EAC: 'Environmental Assessment Certificate (EAC)',
} as const;

const COMPLEXITY = { 'pre-2014': 'Pre-2014', simple: 'Simple', typical: 'Typical', complex: 'Complex' } as const;

/** The Details button on a sheet work row; `className` gives each view its own look. */
export function DetailsToggle(props: { className: string; title: string; controls: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`wp-toggle ${props.className}`}
      aria-expanded={props.open}
      aria-controls={props.controls}
      aria-label={`Details for ${props.title}`}
      onClick={props.onToggle}
    >
      <svg className="wp-toggle__chevron" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
        <path d="M3.5 1.5 7 5 3.5 8.5" fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
      Details
    </button>
  );
}

function Loading() {
  return (
    <div className="wp-details__loading">
      <p className="visually-hidden">Loading details…</p>
      <span className="skeleton skeleton--text" aria-hidden="true" style={{ width: '45%' }} />
      <span className="skeleton skeleton--text" aria-hidden="true" style={{ width: '60%' }} />
      <span className="skeleton skeleton--text" aria-hidden="true" style={{ width: '35%' }} />
    </div>
  );
}

/** A sheet work's stored phases, milestones and interruptions, under facts the Workplans row does not show. */
export function WorkDetails({ row, id }: { row: WorkRow; id: string }) {
  const { work } = row;
  const { data } = useProjects('');
  const proponent = data?.projects.find((candidate) => String(candidate.id) === work.projectId)?.proponent;
  const { data: works, isLoading } = useSheetWorks(work.projectId);
  const stored: SheetWork | undefined = works?.find((sheet) => sheet.workId === work.workId);
  const facts = [
    work.certificateKind && CERTIFICATE[work.certificateKind],
    work.complexityCode && `Complexity: ${COMPLEXITY[work.complexityCode]}`,
    work.transitionIn && movedText('from', work.transitionIn.fromActYear, work.transitionIn.date),
    row.region && `Region: ${row.region}`,
    proponent && `Proponent: ${proponent}`,
  ].filter(Boolean);
  const title = work.title || 'Untitled work';
  return (
    <section
      id={id}
      className="wp-details"
      aria-label={work.actYear ? `${title}, ${work.actYear} Act` : title}
      aria-busy={isLoading}
    >
      {facts.length > 0 && <p className="wp-details__facts">{facts.join(' · ')}</p>}
      {isLoading && <Loading />}
      {stored && (
        <ul className="ps-list">
          <SheetWorkRow work={stored} heading={false} />
        </ul>
      )}
      <div role="status">
        {!isLoading &&
          (stored ? (
            <span className="visually-hidden">Details loaded</span>
          ) : (
            <p className="ps-note wp-details__note">
              Details are not available. <Link to={projectDetailsPath(work.projectId)}>Open the project page</Link>
            </p>
          ))}
      </div>
    </section>
  );
}
