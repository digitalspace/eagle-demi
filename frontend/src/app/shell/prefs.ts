import { SCREENS } from './screens';

export interface Prefs { landing: string; perPage: number; }

export const LANDING_OPTIONS = [
  { key: 'map', label: 'Map Explorer' },
  { key: 'index', label: 'Index Search' },
  { key: 'content', label: 'Document Content Search' },
  { key: 'summary', label: 'AI Summary' }
];

export const PER_PAGE_OPTIONS = [6, 12, 24];
export const PREFS_KEY = 'demi.prefs';
export const DEFAULT_PREFS: Prefs = { landing: 'map', perPage: 6 };

/** Read `demi.prefs` from localStorage, validated against known screens/page sizes. */
export function readPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
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

export function writePrefs(prefs: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Private-browsing quota or a blocked store: the choice still holds for this page view.
  }
}
