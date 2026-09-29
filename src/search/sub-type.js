'use strict';

/**
 * Track's `sub_type_name` (stored as `projectSubType`) put into eagle-admin's PROJECT_SUBTYPES
 * vocabulary, so a project with no Eagle `sector` still shows a sub-type eagle-public can filter
 * on. 26 of Track's 28 names already match; the two below do not.
 *
 * Solid waste was renamed between the 2002 and 2018 lists, so it follows the project's
 * legislation year. No year reads as 2018, the current Act.
 */
const TRANSMISSION_LINES = 'Transmission Lines';
const SOLID_WASTE = 'Solid Waste Management Facilities';

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
  if (name === SOLID_WASTE) {
    // parseInt, not Number: Eagle's `legislation` can be a label such as "2002 Environmental
    // Assessment Act" as well as the bare year.
    const year = parseInt(String(legislationYear ?? ''), 10);
    return year <= 2002
      ? 'Local Government Solid Waste Management Facilities'
      : 'Solid Waste Management';
  }
  return name;
}

module.exports = { normalizeSubType };
