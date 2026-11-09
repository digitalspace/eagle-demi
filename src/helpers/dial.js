'use strict';

// Catalog entries and per-record dials are keyed by the top-level field: `eacDecision._id` is `eacDecision`.
const topField = field => field.split('.')[0];

/** The record's own dial on `field` may hide it below the caller's level; such a record never matches. */
function dialAllows(field, level) {
  const dial = `c.vis[${JSON.stringify(topField(field))}]`;
  return `(NOT IS_DEFINED(${dial}) OR ${dial} >= ${level})`;
}

module.exports = { topField, dialAllows };
