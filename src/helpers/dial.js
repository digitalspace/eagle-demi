'use strict';

const { CATALOGS } = require('../vis/catalog');

// Catalog entries and per-record dials are keyed by the top-level field: `eacDecision._id` is `eacDecision`.
const topField = field => field.split('.')[0];

// A top-level key with `dialOf` is a stored copy of that field, so its dial reaches the copy too.
const SOURCE_OF = new Map(Object.values(CATALOGS).flatMap(Object.entries)
  .filter(([field, entry]) => !field.includes('.') && entry && entry.dialOf).map(([field, entry]) => [field, entry.dialOf]));

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
