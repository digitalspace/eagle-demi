import type { useProjectFacts } from '../api/project-summary';

/** The facts read's failure banner, or its loading header while nothing has landed. */
export function ProjectFactsState({ query }: { query: ReturnType<typeof useProjectFacts> }) {
  if (query.isError) {
    return (
      <div className="callout callout--warning" role="alert">
        <p>{query.error instanceof Error ? query.error.message : 'Could not load the project.'}</p>
      </div>
    );
  }
  if (!query.isLoading) return null;
  return (
    <header className="ps__header" aria-busy="true">
      <p className="visually-hidden">Loading the project record…</p>
      <span className="skeleton skeleton--text" aria-hidden="true" style={{ width: '14rem' }} />
      <span className="skeleton" aria-hidden="true" style={{ width: '24rem', height: '2.4rem', margin: '0.5rem 0' }} />
      <span className="skeleton skeleton--text" aria-hidden="true" style={{ width: '20rem' }} />
    </header>
  );
}
