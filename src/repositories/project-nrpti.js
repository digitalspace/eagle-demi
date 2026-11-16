'use strict';

/**
 * The NRPTI sync's side of the projects container: the Eagle id to DEMI id link map, and the
 * `sources.nrpti` summary block. Writer side only, under systemAccess; no route reads through here.
 */

const cosmos = require('../db/cosmos-nosql');
const projects = require('./projects');
const { systemAccess } = require('../helpers/access-sql');
const { NOT_DELETED, isDefinedAndNotNull, selectWhere, fetchAll } = require('./_sql');

const SUMMARY_PATH = '/sources/nrpti';

// A boolean marker, not the Track block: pickByEagleId only asks whether `sources.track` is truthy.
const LINK_SELECT = 'VALUE { "id": c.id, "eagleId": c.eagleId, ' +
  '"sources": { "track": (IS_DEFINED(c.sources.track) AND NOT IS_NULL(c.sources.track)) } }';

/** Eagle id to DEMI project id, picked as `GET /projects/:eagleId` picks; deleted rows never link. */
async function eagleIdMap() {
  const rows = await fetchAll(projects.CONTAINER, selectWhere({
    access: systemAccess(),
    partitionField: projects.PARTITION_FIELD,
    criteria: [isDefinedAndNotNull('eagleId'), NOT_DELETED],
    select: LINK_SELECT
  }));
  const groups = new Map();
  for (const row of rows) {
    const key = String(row.eagleId);
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  const map = new Map();
  for (const [eagleId, group] of groups) map.set(eagleId, String(projects.pickByEagleId(group, eagleId).id));
  return map;
}

async function patchSummary(id, summary) {
  return cosmos.patch(projects.CONTAINER, String(id), String(id), [
    { op: 'set', path: SUMMARY_PATH, value: summary }
  ]);
}

async function removeSummary(id) {
  return cosmos.patch(projects.CONTAINER, String(id), String(id), [{ op: 'remove', path: SUMMARY_PATH }]);
}

/** Every project id holding a summary, deleted rows included, so a clear reaches them too. */
async function listIdsWithSummary() {
  return fetchAll(projects.CONTAINER, selectWhere({
    access: systemAccess(),
    partitionField: projects.PARTITION_FIELD,
    criteria: [{ clause: 'IS_DEFINED(c.sources.nrpti)', params: [] }],
    select: 'VALUE c.id'
  }));
}

module.exports = {
  eagleIdMap,
  patchSummary,
  removeSummary,
  listIdsWithSummary
};
