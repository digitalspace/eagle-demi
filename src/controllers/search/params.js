'use strict';

const eagleQuery = require('../../search/eagle-query');
const updatesRepo = require('../../repositories/updates');

/**
 * One filter value in EITHER wire shape, `&key=v` or `&and[key]=v`. A repeat takes the first:
 * these are point lookups.
 */
function filterValue(query, key) {
  for (const [k, v] of eagleQuery.andParams(query || {})) {
    if (k === key) return String(firstValue(v));
  }
  const bare = (query || {})[key];
  if (bare === undefined) return null;
  return String(firstValue(bare));
}

/**
 * EVERY value of one filter key, in either wire shape, split by `eagleQuery.valuesOf` as the INDEX
 * path does. `null` = key not sent; `[]` = sent but empty (`and[type]=`).
 */
function filterValues(query, key) {
  const raw = [];
  for (const [k, v] of eagleQuery.andParams(query || {})) {
    if (k === key) raw.push(v);
  }
  if ((query || {})[key] !== undefined) raw.push(query[key]);
  return raw.length ? eagleQuery.valuesOf(raw) : null;
}

/**
 * One value from a query parameter `querystring.parse` may have handed back as an ARRAY — a
 * repeated key stays an array there, and a string method called on it throws.
 */
function firstValue(raw) {
  return Array.isArray(raw) ? raw[0] : raw;
}

/** One day, in ms — the step from a date's midnight to the next one. */
const DAY_MS = 86400000;

/** Midnight UTC of the day a wire date names, or null when no `Date` can read it. */
function utcDayStart(value) {
  const d = new Date(String(value));
  if (isNaN(d.getTime())) return null;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * `and[dateAddedStart]`/`and[dateAddedEnd]` as the INDEX path's half-open window of whole UTC days.
 * An unreadable date is left out of `applied`, so it is reported dropped rather than ignored.
 * @returns {{dateAddedFrom?: string, dateAddedBefore?: string, applied: string[]}}
 */
function activityWindow(query) {
  const bounds = { applied: [] };
  for (const key of ['dateAddedStart', 'dateAddedEnd']) {
    const raw = filterValue(query, key);
    if (raw === null) continue;
    if (raw.trim() === '') { bounds.applied.push(key); continue; }
    const day = utcDayStart(raw);
    if (day === null) continue;
    bounds.applied.push(key);
    if (key === 'dateAddedStart') bounds.dateAddedFrom = new Date(day).toISOString();
    else bounds.dateAddedBefore = new Date(day + DAY_MS).toISOString();
  }
  return bounds;
}

/**
 * `and[documentUrl]` is a presence filter: only `true` and `false`, as on the index path. Any other
 * value is reported dropped, never matched as a URL.
 * @returns {{hasDocument?: boolean, applied: string[]}}
 */
function documentFilter(query) {
  const raw = filterValue(query, 'documentUrl');
  if (raw === null) return { applied: [] };
  // Sent with nothing after the `=` is a cleared checkbox: consumed, and no narrowing.
  if (raw.trim() === '') return { applied: ['documentUrl'] };
  if (raw !== 'true' && raw !== 'false') return { applied: [] };
  return { hasDocument: raw === 'true', applied: ['documentUrl'] };
}

/**
 * A keyword parameter's first value (a repeated key arrives as an array), whitespace collapsed: the
 * string `/search/counts` caches on.
 */
const keywordText = (raw) => String(firstValue(raw) || '').replace(/\s+/g, ' ').trim();

/** The most rows `top=true` answers. A longer list is a page, not a strip. */
const TOP_MAX_ROWS = 20;

/**
 * `pageSize` on a strip read: absent is `updatesRepo.TOP_ROWS`, so every existing `top=true` caller
 * is unchanged. Anything but an integer from 1 to TOP_MAX_ROWS is REFUSED rather than clamped.
 */
function stripLimit(query) {
  const raw = firstValue(query.pageSize);
  if (raw === undefined) return { limit: updatesRepo.TOP_ROWS };
  const n = Number(raw);
  if (!/^\d+$/.test(String(raw)) || n < 1 || n > TOP_MAX_ROWS) {
    return { error: `pageSize must be an integer from 1 to ${TOP_MAX_ROWS} here, not '${raw}'` };
  }
  return { limit: n };
}

module.exports = {
  filterValue,
  filterValues,
  firstValue,
  activityWindow,
  DAY_MS,
  documentFilter,
  keywordText,
  stripLimit
};
