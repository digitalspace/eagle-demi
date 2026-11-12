'use strict';

const { CATALOGS } = require('../vis/catalog');

// Catalog entries and per-record dials are keyed by the top-level field: `eacDecision._id` is `eacDecision`.
const topField = field => field.split('.')[0];

// A top-level key with `dialOf` is a stored copy of that field, so its dial reaches the copy too.
// Keyed by field name across kinds, so one name may copy only one source.
const SOURCE_OF = new Map();
for (const [field, entry] of Object.values(CATALOGS).flatMap(Object.entries)) {
  if (field.includes('.') || !entry || !entry.dialOf) continue;
  if (SOURCE_OF.has(field) && SOURCE_OF.get(field) !== entry.dialOf) {
    throw new Error(`[vis] ${field} copies both ${SOURCE_OF.get(field)} and ${entry.dialOf}`);
  }
  SOURCE_OF.set(field, entry.dialOf);
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
