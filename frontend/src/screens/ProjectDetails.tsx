import { Link, useParams } from 'react-router';
import { projectEagleId, useProjectFacts } from '../api/project-summary';
import { NrptiPanel } from './NrptiPanel';
import { ProjectFactsState } from './ProjectFactsState';
import { SheetWorksPanel } from './SheetWorksPanel';

/** Extra data about one project, one section each, beside the summary page. */
export function ProjectDetails() {
  const projectId = useParams().id || '';
  const factsQuery = useProjectFacts(projectId);
  const facts = factsQuery.data ?? null;
  const eagleId = projectEagleId(facts);

  return (
    <div className="ps">
      <Link className="ps__back" to="/project-details">
        <span aria-hidden="true">←</span> All projects
      </Link>

      <ProjectFactsState query={factsQuery} />

      {facts && (
        <>
          <header className="ps__header">
            <p className="micro-label ps__eyebrow">Project details</p>
            <h1 className="ps__title">{facts.name}</h1>
          </header>

          <NrptiPanel key={eagleId} eagleId={eagleId} />
          <SheetWorksPanel projectId={String(facts.id)} />
        </>
      )}
    </div>
  );
}
