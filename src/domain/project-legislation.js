'use strict';

/**
 * The legislation registry and the locked-Act rule, ported from eagle-api
 * `api/helpers/constants.js:55-102` and `api/controllers/project.js:580-600` (rules in
 * docs/eagle-api-port.md, Project).
 *
 * A DEMI project row is flat: it holds the current legislation block only, as `legislationYear`
 * and its `legislation` label (`merge/project.js`, `flattenEagleProject`).
 */

/** `label` is the `legislation` string eagle-public matches on; a `locked` Act is never left. */
const LEGISLATIONS = Object.freeze({
  1996: Object.freeze({ label: '1996 Environmental Assessment Act' }),
  2002: Object.freeze({ label: '2002 Environmental Assessment Act' }),
  2018: Object.freeze({ label: '2018 Environmental Assessment Act' }),
  2025: Object.freeze({ label: 'Building Canada Act', locked: true })
});

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

module.exports = { lockRefusal };
