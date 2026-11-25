import { ApiError, errorMessage } from '../api/client';
import './workplans.css';

/** 404 and 403 are expected here: the route is served on dev and test only, and to staff only. */
export function LoadFailure({ error }: { error: Error }) {
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

export function Loading() {
  return (
    <section className="panel panel--padded wp-page__loading" aria-busy="true">
      <span className="visually-hidden">Loading workplans…</span>
      {[60, 45, 70, 50].map((width) => (
        <span key={width} className="skeleton skeleton--text" style={{ width: `${width}%` }} aria-hidden="true" />
      ))}
    </section>
  );
}
