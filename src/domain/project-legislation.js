'use strict';

/**
 * The legislation registry, the locked-Act rule and the publish year switch, ported from eagle-api
 * `api/helpers/constants.js:55-102` and `api/controllers/project.js:580-600,776-801` (rules in
 * docs/eagle-api-port.md, Project).
 *
 * A DEMI project row's top level is the current block, as `legislationYear` and its `legislation`
 * label. Every block, `currentLegislationYear` and `legislationYearList` sit beside it and in
 * `sources.eagle`, which a switch merges again (`merge/project.js`).
 */

/**
 * `label` is the `legislation` string eagle-public matches on; a `locked` Act is never left. An Act
 * with no phase List rows of its own files under those of `phaseRowsYear`.
 */
const LEGISLATIONS = Object.freeze({
  1996: Object.freeze({ label: '1996 Environmental Assessment Act', inForce: '1995-06-30', phaseRowsYear: 2002 }),
  2002: Object.freeze({ label: '2002 Environmental Assessment Act', inForce: '2002-12-30' }),
  2018: Object.freeze({ label: '2018 Environmental Assessment Act', inForce: '2019-12-16' }),
  2025: Object.freeze({ label: 'Building Canada Act', locked: true, inForce: null })
});

// Eagle stores a cleared date as epoch zero in Pacific time (1969-12-31T08:00Z); no EA record
// is that old, so anything before this is junk, not history.
const EAGLE_DATE_FLOOR = Date.UTC(1971, 0, 1);

const beforeDateFloor = (v) =>
  (typeof v === 'string' || v instanceof Date) && new Date(v).getTime() < EAGLE_DATE_FLOOR;

const isRegistryYear = (year) => Object.prototype.hasOwnProperty.call(LEGISLATIONS, year);

/** The registry year a row is under: its `legislationYear`, else the year its label names. */
function yearOf(row) {
  if (!row) return null;
  const year = Number(row.legislationYear);
  if (isRegistryYear(year)) return year;
  const named = Object.keys(LEGISLATIONS).find(key => LEGISLATIONS[key].label === row.legislation);
  return named ? Number(named) : null;
}

/**
 * The 409 message for PUT `changes` that would move `row` off a locked Act, else null.
 * DEMI's PUT stores `null` and the label as sent, where eagle-api ignored both, so both are checked.
 */
function lockRefusal(row, changes) {
  const year = yearOf(row);
  if (year === null || !LEGISLATIONS[year].locked) return null;
  const { label } = LEGISLATIONS[year];
  const movesYear = changes.legislationYear !== undefined && changes.legislationYear !== year;
  const movesLabel = changes.legislation !== undefined && changes.legislation !== label;
  return movesYear || movesLabel ? `Project is under the ${label}` : null;
}

/**
 * Where publishing `row` under `year` leaves it: `{ key }` names the block to make current, `{ key:
 * null }` keeps the current one, `{ status, error }` refuses.
 */
function yearSwitch(row, year) {
  const locked = lockRefusal(row, { legislationYear: year });
  if (locked) return { status: 409, error: locked };
  if (!isRegistryYear(year)) return { status: 404, error: 'Unknown legislation year' };
  const key = `legislation_${year}`;
  const eagle = (row.sources && row.sources.eagle) || {};
  const current = eagle.currentLegislationYear || (yearOf(row) && `legislation_${yearOf(row)}`);
  if (key === current) return { key: null };
  const listed = Array.isArray(eagle.legislationYearList) && eagle.legislationYearList.map(Number).includes(year);
  if (!listed || !(eagle[key] && eagle[key].name)) {
    return { status: 409, error: `Project has no content under legislation year ${year}` };
  }
  return { key };
}

module.exports = { LEGISLATIONS, EAGLE_DATE_FLOOR, beforeDateFloor, isRegistryYear, yearOf, lockRefusal, yearSwitch };
