'use strict';

const projects = require('./projects');

/** Every entity with a field catalog. An entity absent here has no policy, so it has no response. */
const CATALOGS = { projects };

/** Throws rather than returning an empty catalog: no policy must never read as "nothing hidden". */
function catalogFor(entity) {
  const catalog = CATALOGS[entity];
  if (!catalog) throw new Error(`[vis] no field catalog for entity: ${entity}`);
  return catalog;
}

module.exports = { catalogFor, CATALOGS };
