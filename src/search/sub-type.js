'use strict';

/**
 * Track's `sub_type_name` (stored as `projectSubType`) in eagle-admin's PROJECT_SUBTYPES words for
 * the project's Act. Renamed entries follow the legislation year; no year reads as 2018.
 */
const TRANSMISSION_LINES = 'Transmission Lines';
const SOLID_WASTE = 'Solid Waste Management Facilities';
const MARINE_PORT = 'Marine Port Projects';

/**
 * @param {unknown} value            Track sub-type name.
 * @param {unknown} legislationYear  2002, 2018, or a label starting with the year; optional.
 * @returns {string|null} null when there is no sub-type.
 */
function normalizeSubType(value, legislationYear) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name) return null;

  if (name === TRANSMISSION_LINES) return 'Electric Transmission Lines';
  if (name !== SOLID_WASTE && name !== MARINE_PORT) return name;

  // parseInt, not Number: Eagle's `legislation` can be a label such as "2002 Environmental
  // Assessment Act" as well as the bare year.
  const act2002 = parseInt(String(legislationYear ?? ''), 10) <= 2002;
  if (name === MARINE_PORT) return act2002 ? 'Marine Port Facilities' : MARINE_PORT;
  return act2002 ? 'Local Government Solid Waste Management Facilities' : 'Solid Waste Management';
}

/**
 * normalizeSubType run backwards for a filter on the shown name: each stored sub-type that shows
 * as `shown`, and under which Act. 2002 means a legislation year of 2002 or earlier.
 * @returns {{name: string, under2002: boolean, under2018: boolean}[]}
 */
function subTypeSources(shown) {
  const name = typeof shown === 'string' ? shown.trim() : '';
  if (!name) return [];
  return [...new Set([name, TRANSMISSION_LINES, SOLID_WASTE, MARINE_PORT])]
    .map(source => ({
      name: source,
      under2002: normalizeSubType(source, 2002) === name,
      under2018: normalizeSubType(source, 2018) === name
    }))
    .filter(s => s.under2002 || s.under2018);
}

module.exports = { normalizeSubType, subTypeSources };
