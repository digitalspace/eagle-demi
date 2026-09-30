'use strict';

/**
 * Track's `sub_type_name` (stored as `projectSubType`) put into eagle-admin's PROJECT_SUBTYPES
 * vocabulary, so a project with no Eagle `sector` still shows a sub-type. eagle-admin keeps one
 * list per Act: 26 of Track's 28 names are on the 2018 list and 24 on the 2002 one.
 *
 * Transmission lines take one name under both Acts. Solid waste and marine ports were renamed
 * between the lists, so they follow the project's legislation year; no year reads as 2018, the
 * current Act. Oil Refineries has no 2002 entry and passes through unchanged.
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

module.exports = { normalizeSubType };
