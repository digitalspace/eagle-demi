import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { config } from '../config';
import { AccountMenu } from './AccountMenu';
import { HowBuilt } from './HowBuilt';
import { readNavOpen, writeNavOpen } from './prefs';
import { screenKeyOf } from './screenKey';
import { GROUPS, SCREENS } from './screens';
import { useNarrow } from './useNarrow';
import './shell.css';

const SECTIONS = GROUPS.map((heading) => ({
  heading,
  items: SCREENS.filter((screen) => screen.group === heading),
}));

const howBuilt: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.4rem',
  padding: '0.4rem 0.85rem',
  borderRadius: 'var(--layout-border-radius-circular)',
  background: 'var(--theme-primary-gold)',
  color: 'var(--surface-color-primary-default)',
  border: 'none',
  font: 'var(--typography-bold-small-body)',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
};

const MAP_MAIN: CSSProperties = { padding: 0, display: 'flex', flexDirection: 'column', minHeight: 0 };
const SCREEN_MAIN: CSSProperties = { padding: 'var(--layout-padding-large)' };

export function Shell() {
  const { pathname } = useLocation();
  const narrow = useNarrow();
  /** Above the breakpoint only: off-canvas the drawer has its own open state. */
  const [navOpen, setNavOpen] = useState(readNavOpen);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const c = config();

  const screenKey = screenKeyOf(pathname);
  /** What the rail's own toggle shows and flips: the drawer off-canvas, the rail above it. */
  const navExpanded = narrow ? drawerOpen : navOpen;
  /**
   * Off-canvas and closed the rail leaves the page entirely. Collapsed above the breakpoint it
   * stays in the row as a narrow strip, because the toggle inside it is the only way to reopen it.
   */
  const navHidden = narrow && !drawerOpen;

  // Leaving the narrow layout closes the drawer, so coming back to it never lands mid-open.
  const [wasNarrow, setWasNarrow] = useState(narrow);
  if (wasNarrow !== narrow) {
    setWasNarrow(narrow);
    if (!narrow) setDrawerOpen(false);
  }

  // Focus is sent back to the control that opened the drawer: closing hides the rail outright, so
  // anything focused inside it would otherwise drop to the document.
  const closeDrawer = useCallback(() => {
    setDrawerOpen((open) => {
      if (open) menuButton.current?.focus();
      return false;
    });
  }, []);

  // Only while there is a drawer to close: a document-wide Escape listener that outlives the
  // drawer steals the key from anything else on the page that wants it.
  useEffect(() => {
    if (!narrow || !drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDrawer();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [narrow, drawerOpen, closeDrawer]);

  const toggleNav = () => {
    if (narrow) {
      setDrawerOpen((open) => {
        if (open) menuButton.current?.focus();
        return !open;
      });
      return;
    }
    setNavOpen((open) => {
      writeNavOpen(!open);
      return !open;
    });
  };

  return (
    <>
      <div className="app">
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <header className="eao-header app-header">
          {/* The drawer control, and only that: above the breakpoint the rail carries its own toggle. */}
          {narrow && (
            <button
              type="button"
              className="app-header__menu"
              ref={menuButton}
              onClick={toggleNav}
              aria-label="Main navigation"
              aria-controls="app-nav"
              aria-expanded={drawerOpen}
            >
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <line x1="4" y1="7" x2="20" y2="7"></line>
                <line x1="4" y1="12" x2="20" y2="12"></line>
                <line x1="4" y1="17" x2="20" y2="17"></line>
              </svg>
            </button>
          )}
          <img
            className="eao-header__mark app-header__mark"
            src="/assets/bcgov-header-vert.png"
            alt="Government of British Columbia"
          />
          <div className="app-header__centre">
            <p className="eao-header__title app-header__title">
              DEMI<span className="app-header__title-rest"> — Digital File Library &amp; Registry</span>
            </p>
            {c.ENVIRONMENT && <span className="app-header__env">{c.ENVIRONMENT}</span>}
          </div>
          <div className="eao-header__actions">
            <button
              type="button"
              onClick={() => setInfoOpen((open) => !open)}
              aria-label="How this screen is built"
              style={howBuilt}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9"></circle>
                <line x1="12" y1="11" x2="12" y2="16.5"></line>
                <circle cx="12" cy="7.6" r="1.1" fill="currentColor" stroke="none"></circle>
              </svg>
              <span className="app-header__how-label">How this is built</span>
            </button>
            <AccountMenu />
          </div>
        </header>

        <div className="app__body">
          <nav
            id="app-nav"
            className="eao-sidebar app-sidebar"
            aria-label="DEMI"
            data-drawer={narrow ? (drawerOpen ? 'open' : 'closed') : undefined}
            data-open={narrow ? undefined : String(navOpen)}
            data-collapsed={navHidden ? '' : undefined}
            inert={navHidden}
          >
            <button
              type="button"
              className="app-sidebar__toggle"
              onClick={toggleNav}
              aria-label="Toggle navigation"
              aria-expanded={navExpanded}
            >
              {navExpanded ? '‹' : '›'}
            </button>
            {navExpanded &&
              SECTIONS.map((section) => (
                <div key={section.heading}>
                  <div className="eao-sidebar__divider app-sidebar__heading">{section.heading}</div>
                  {section.items.map((item) => (
                    <NavLink
                      key={item.key}
                      to={item.path}
                      className={() => 'app-sidebar__link'}
                      onClick={closeDrawer}
                    >
                      {item.label}
                    </NavLink>
                  ))}
                </div>
              ))}
          </nav>

          <main
            id="main"
            tabIndex={-1}
            className="app__main"
            style={screenKey === 'map' ? MAP_MAIN : SCREEN_MAIN}
          >
            <Outlet />
          </main>
        </div>

        <footer className="app-footer">
          <span></span>
          <nav aria-label="Footer" className="app-footer__links">
            <a href="https://www2.gov.bc.ca/gov/content/home">Home</a>
            <a href="https://www2.gov.bc.ca/gov/content/home/disclaimer">Disclaimer</a>
            <a href="https://www2.gov.bc.ca/gov/content/home/privacy">Privacy</a>
            <a href="https://www2.gov.bc.ca/gov/content/home/accessibility">Accessibility</a>
            <a href="https://www2.gov.bc.ca/gov/content/home/copyright">Copyright</a>
            <a href="https://www2.gov.bc.ca/gov/content/home/get-help-with-government-services">
              Contact us
            </a>
          </nav>
          <span className="app-footer__build">DEMI · {c.ENVIRONMENT}</span>
        </footer>
      </div>

      {infoOpen && <HowBuilt screenKey={screenKey} onClose={() => setInfoOpen(false)} />}
    </>
  );
}
