'use strict';

/**
 * Project fragments — independently ACL'd slices of a project.
 *
 * Container `project_fragments`, partitioned by `/projectId`.
 *
 * This is how fragment-level permissions work: "some users can see the project but not its
 * NRPTI portion" becomes an ITEM with its own `read[]`, not a special case inside a query.
 * The standard visibility predicate then applies unchanged — no per-field policy engine, and
 * a caller who may not see the fragment never fetches it, rather than fetching and stripping.
 *
 * It is also why NRPTI aggregates moved out of `sources.nrpti`: the same change fixes the
 * 2 MB item ceiling and makes the fragment independently permissionable.
 */

const cosmos = require('../db/cosmos-nosql');
const { canRead } = require('../helpers/access-sql');
const { eq, selectWhere } = require('./_sql');

const CONTAINER = 'project_fragments';
const PARTITION_FIELD = 'projectId';

/** Fragment ids are deterministic so a re-seed updates rather than duplicates. */
function fragmentId(projectId, fragmentType) {
  return `${projectId}:${fragmentType}`;
}

/**
 * Fragments of one project that this caller may see.
 * Single-partition. A caller lacking the fragment's roles simply gets fewer items back.
 */
async function listForProject(access, projectId) {
  const spec = selectWhere({
    access,
    partitionField: PARTITION_FIELD,
    criteria: [eq('projectId', String(projectId), '@projectId')]
  });
  return cosmos.query(CONTAINER, spec, { partitionKey: String(projectId) });
}

async function get(access, projectId, fragmentType) {
  const doc = await cosmos.readItem(
    CONTAINER,
    fragmentId(projectId, fragmentType),
    String(projectId)
  );
  if (!doc) return null;
  return canRead(doc, access, PARTITION_FIELD) ? doc : null;
}

/**
 * @param {string[]} read  the fragment's own ACL — NOT inherited from the project, which is
 *                         the entire point: it may be narrower than the project's.
 */
async function put(projectId, fragmentType, data, read) {
  if (!Array.isArray(read) || read.length === 0) {
    // Fail closed. A fragment with no ACL would fall back to the isPublished mirror and could
    // become publicly readable — the opposite of why fragments exist.
    throw new TypeError('[fragments] put() requires a non-empty read[] ACL');
  }

  return cosmos.upsert(CONTAINER, {
    id: fragmentId(projectId, fragmentType),
    projectId: String(projectId),
    fragmentType,
    read,
    data,
    updatedAt: new Date().toISOString()
  });
}

async function remove(projectId, fragmentType) {
  return cosmos.remove(CONTAINER, fragmentId(projectId, fragmentType), String(projectId));
}

module.exports = {
  CONTAINER,
  PARTITION_FIELD,
  fragmentId,
  listForProject,
  get,
  put,
  remove
};
