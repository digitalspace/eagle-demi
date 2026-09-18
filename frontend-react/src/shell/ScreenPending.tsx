import { TECH } from './screens';

/** Stands in for a screen until its own slice ports it, so the shell around it can be compared. */
export function ScreenPending({ screenKey }: { screenKey: string }) {
  const tech = TECH[screenKey] ?? TECH['map'];

  return (
    <section className="panel">
      <h1>{tech.title}</h1>
    </section>
  );
}
