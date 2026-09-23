import { SCREENS } from './screens';

export interface Prefs { landing: string; perPage: number; }

export const LANDING_OPTIONS = [
  { key: 'map', label: 'Map Explorer' },
  { key: 'search', label: 'Search' },
  { key: 'summary', label: 'AI Search Summary' }
];

export const PER_PAGE_OPTIONS = [6, 12, 24];
export const PREFS_KEY = 'demi.prefs';
export const NAV_KEY = 'demi.navOpen';
export const DEFAULT_PREFS: Prefs = { landing: 'map', perPage: 6 };

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private-browsing quota or a blocked store: the choice still holds for this page view.
  }
}

/** Read `demi.prefs` from localStorage, validated against known screens/page sizes. */
export function readPrefs(): Prefs {
  try {
    const raw = readStored(PREFS_KEY);
    const saved = raw ? JSON.parse(raw) : null;
    if (!saved) return { ...DEFAULT_PREFS };
    return {
      landing: SCREENS.some(s => s.key === saved.landing) ? saved.landing : DEFAULT_PREFS.landing,
      perPage: PER_PAGE_OPTIONS.includes(saved.perPage) ? saved.perPage : DEFAULT_PREFS.perPage
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Route path for a landing key; screen keys are not paths (`me` is /workspace). Unknown key: the default. */
export function landingPath(key: string): string {
  const byKey = (k: string) => SCREENS.find(s => s.key === k);
  return (byKey(key) ?? byKey(DEFAULT_PREFS.landing)!).path;
}

export function writePrefs(prefs: Prefs) {
  writeStored(PREFS_KEY, JSON.stringify(prefs));
}

/**
 * Sidebar state, kept in this browser only: it describes a window, not the account, and
 * `PUT /me/prefs` rejects keys outside its allow-list. Default open.
 */
export function readNavOpen(): boolean {
  return readStored(NAV_KEY) !== 'false';
}

export function writeNavOpen(open: boolean) {
  writeStored(NAV_KEY, String(open));
}
