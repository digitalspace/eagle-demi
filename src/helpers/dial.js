'use strict';

const { CATALOGS } = require('../vis/catalog');

// Catalog entries and per-record dials are keyed by the top-level field: `eacDecision._id` is `eacDecision`.
const topField = field => field.split('.')[0];

// A top-level key with `dialOf` (a stored copy) or `queryDialOf` (a query-only link, redaction ignores
// it) answers to that field's dial too. Keyed by field name across kinds, so one name has one source.
const SOURCE_OF = new Map();
for (const [field, entry] of Object.values(CATALOGS).flatMap(Object.entries)) {
  const source = entry && (entry.dialOf || entry.queryDialOf);
  if (field.includes('.') || !source) continue;
  if (SOURCE_OF.has(field) && SOURCE_OF.get(field) !== source) {
    throw new Error(`[vis] ${field} copies both ${SOURCE_OF.get(field)} and ${source}`);
  }
  SOURCE_OF.set(field, source);
}

function ownDial(top, level) {
  const dial = `c.vis[${JSON.stringify(top)}]`;
  return `(NOT IS_DEFINED(${dial}) OR ${dial} >= ${level})`;
}

/** The record's own dial on `field` may hide it below the caller's level; such a record never matches. */
function dialAllows(field, level) {
  const top = topField(field);
  return SOURCE_OF.has(top) ? `(${ownDial(top, level)} AND ${ownDial(SOURCE_OF.get(top), level)})` : ownDial(top, level);
}

module.exports = { topField, dialAllows };
