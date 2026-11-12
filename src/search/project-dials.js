'use strict';

const projects = require('../repositories/projects');
const { inClause } = require('../helpers/access-odata');
const { storedFieldsOf } = require('../vis/catalog/index-projects-renames');

/**
 * `not search.in(id, ...)` over the projects whose own dial hides, from this caller, a projects index
 * column the call reads: `indexFields` (array) or `searchedColumns` (a `searchFields` string). Null when none.
 */
async function dialExclusion(access, indexFields, searchedColumns) {
  const columns = [...(indexFields || []), ...(searchedColumns ? searchedColumns.split(',') : [])];
  const hidden = await projects.listDialHiddenIds(access, columns.flatMap(storedFieldsOf));
  return hidden.length ? `not ${inClause('id', hidden)}` : null;
}

module.exports = { dialExclusion };
