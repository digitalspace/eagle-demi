'use strict';

const projects = require('./projects');
const documents = require('./documents');
// Keyed on AI SEARCH field names, not Cosmos ones — the indexer renames columns
// (docs/rbac-architecture.md §2 item 9).
const indexProjects = require('./index-projects');
const indexDocuments = require('./index-documents');

/** Every entity with a field catalog. An entity absent here has no policy, so it has no response. */
const CATALOGS = {
  projects,
  documents,
  'index-projects': indexProjects,
  'index-documents': indexDocuments
};

/** Throws rather than returning an empty catalog: no policy must never read as "nothing hidden". */
function catalogFor(entity) {
  const catalog = CATALOGS[entity];
  if (!catalog) throw new Error(`[vis] no field catalog for entity: ${entity}`);
  return catalog;
}

module.exports = { catalogFor, CATALOGS };
