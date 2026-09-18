import { readNavOpen } from './prefs';
import { useNarrow } from './useNarrow';

const BARS = [1, 2, 3, 4, 5, 6];

/** The shell, not a message: the sign-in/app swap lands into the same boxes, so nothing jumps. */
export function Skeleton() {
  const narrow = useNarrow();
  const navOpen = readNavOpen();

  return (
    <div className="app" aria-busy="true">
      <p className="visually-hidden">Checking your session…</p>
      <header className="eao-header app-header" aria-hidden="true">
        <span className="skeleton" style={{ height: '60px', width: '3.5rem' }}></span>
        <span className="skeleton skeleton--text" style={{ width: '22rem' }}></span>
        <span
          className="skeleton skeleton--circle"
          style={{ height: '2rem', width: '2rem', marginLeft: 'auto' }}
        ></span>
      </header>
      <div className="app__body">
        {!narrow && navOpen && (
          <nav className="eao-sidebar app-sidebar" aria-hidden="true">
            {BARS.map((bar) => (
              <span
                key={bar}
                className="skeleton skeleton--text"
                style={{
                  width: '60%',
                  margin: 'var(--layout-margin-small) var(--layout-margin-medium)',
                }}
              ></span>
            ))}
          </nav>
        )}
        <main className="app__main"></main>
      </div>
    </div>
  );
}
