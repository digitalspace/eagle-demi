import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFS,
  NAV_KEY,
  PREFS_KEY,
  readNavOpen,
  readPrefs,
  writeNavOpen,
  writePrefs,
} from './prefs';

afterEach(() => localStorage.clear());

describe('readPrefs', () => {
  it('opens on the map with six per page when nothing is saved', () => {
    expect(readPrefs()).toEqual({ landing: 'map', perPage: 6 });
  });

  it('reads back what was saved', () => {
    writePrefs({ landing: 'search', perPage: 24 });

    expect(readPrefs()).toEqual({ landing: 'search', perPage: 24 });
  });

  it('drops a landing screen that no longer exists', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ landing: 'index', perPage: 12 }));

    expect(readPrefs().landing).toBe(DEFAULT_PREFS.landing);
    expect(readPrefs().perPage).toBe(12);
  });

  it('drops a page size the screens do not offer', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ landing: 'search', perPage: 500 }));

    expect(readPrefs().perPage).toBe(DEFAULT_PREFS.perPage);
  });

  it('falls back to the defaults when the stored value is not JSON', () => {
    localStorage.setItem(PREFS_KEY, 'not json');

    expect(readPrefs()).toEqual(DEFAULT_PREFS);
  });
});

describe('readNavOpen', () => {
  it('starts open', () => {
    expect(readNavOpen()).toBe(true);
  });

  it('remembers a collapsed rail', () => {
    writeNavOpen(false);

    expect(localStorage.getItem(NAV_KEY)).toBe('false');
    expect(readNavOpen()).toBe(false);
  });

  it('keeps the rail out of the account preferences', () => {
    writeNavOpen(false);

    expect(localStorage.getItem(PREFS_KEY)).toBeNull();
  });
});
