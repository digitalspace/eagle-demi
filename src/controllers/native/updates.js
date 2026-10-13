'use strict';

/**
 * Native update reads: `GET /updates`, `/updates/feed` and `/updates/:id`, on the list contract in
 * `helpers/native-query.js`. Every read goes through the repository's publish and parent gates, so
 * a caller below staff sees published rows only.
 *
 * `projectId` on an update holds the EAGLE project id (`repositories/updates.js` SCOPE_FIELD), and
 * `project=` filters on that value as stored.
 */

const updates = require('../../repositories/updates');
const projects = require('../../repositories/projects');
const { listHandler, getHandler, NO_STORE } = require('../nosql/mirror-reads');
const { indexedKind, INDEX_MAPS } = require('../../search/native-index');
const { resolveAccess } = require('../../helpers/access-sql');
const { assertFilterable } = require('../../repositories/_sql');
const { redactAllForAccess } = require('../../vis/redact');
const { serverError } = require('../../helpers/response');

/** Most rows the feed answers; the compat strip refuses past the same 20 (`controllers/search.js`). */
const FEED_MAX_ROWS = 20;

/**
 * `projectName` and `projectEagleId` from the parent project, as this caller may see it. By Eagle
 * id, since that is what an update carries; a parent the caller cannot read adds nothing.
 */
async function updateParentJoin(access, rows) {
  const ids = [...new Set(rows.map(row => row && row.projectId).filter(Boolean).map(String))];
  if (ids.length === 0) return rows;

  const parents = new Map(redactAllForAccess('projects', await projects.listByEagleIds(access, ids), access)
    .map(parent => [String(parent.eagleId), parent]));
  return rows.map((row) => {
    const parent = row && parents.get(String(row.projectId));
    if (!parent) return row;
    return {
      ...row,
      ...(parent.name !== undefined ? { projectName: parent.name } : {}),
      ...(parent.eagleId !== undefined ? { projectEagleId: parent.eagleId } : {})
    };
  });
}

const SPEC = Object.freeze({
  entity: 'updates',
  repository: indexedKind({ index: 'activities', store: updates.nativeRepository }),
  sortKeys: updates.SORTABLE,
  filters: ['projectId', 'type'],
  aliases: { project: 'projectId' },
  multiValueFilters: ['type'],
  qFields: INDEX_MAPS.activities.searched,
  parentJoin: updateParentJoin,
  notFound: 'Update not found'
});

exports.SPEC = SPEC;
exports.FEED_MAX_ROWS = FEED_MAX_ROWS;
exports.getUpdates = listHandler(SPEC);
exports.getUpdate = getHandler(SPEC);

/** The feed's query, or `{ error }`: `limit` once, `type` any number of times, nothing else. */
function parseFeedQuery(query, access) {
  const { limit: raw, type, ...rest } = query || {};
  const unknown = Object.keys(rest)[0];
  if (unknown) return { error: `unknown parameter: ${unknown}` };

  let limit = updates.TOP_ROWS;
  if (raw !== undefined) {
    if (typeof raw !== 'string' || !/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > FEED_MAX_ROWS) {
      return { error: `limit must be a whole number from 1 to ${FEED_MAX_ROWS}, given once` };
    }
    limit = Number(raw);
  }

  if (type === undefined) return { limit };
  try {
    assertFilterable(SPEC.entity, 'type', access);
  } catch (err) {
    return { error: err.message };
  }
  return { limit, types: [...new Set([].concat(type))] };
}

/**
 * `GET /updates/feed`: the home-page strip, pinned updates first and topped up to `limit` rows
 * (default `updates.TOP_ROWS`, at most FEED_MAX_ROWS). `type` narrows the top-up only, as
 * `updates.listTop` does.
 */
exports.getFeed = async (req, res) => {
  try {
    const access = resolveAccess(req);
    if (access.authenticated) res.setHeader('cache-control', NO_STORE);

    const { limit, types, error } = parseFeedQuery(req.query, access);
    if (error) return res.status(400).json({ error });

    const rows = await updates.listTop(access, { limit, types });
    return res.json(await updateParentJoin(access, redactAllForAccess(SPEC.entity, rows, access)));
  } catch (err) {
    return serverError(res, err, 'updates feed failed');
  }
};
