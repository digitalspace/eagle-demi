'use strict';

/**
 * Native update reads: `GET /updates`, `/updates/feed` and `/updates/:id`, on the list contract in
 * `helpers/native-query.js`. Every read goes through the repository's publish and parent gates, so
 * a caller below staff sees published rows only.
 *
 * `projectId` on an update holds the EAGLE project id (`repositories/updates.js` SCOPE_FIELD), and
 * `project=` filters on that value as stored, any of several when repeated.
 */

const updates = require('../../repositories/updates');
const projects = require('../../repositories/projects');
const notifications = require('../../repositories/notifications');
const { listHandler, getHandler, NO_STORE } = require('../nosql/mirror-reads');
const { indexedKind, INDEX_MAPS } = require('../../search/native-index');
const { resolveAccess } = require('../../helpers/access-sql');
const { assertFilterable } = require('../../repositories/_sql');
const { redactAllForAccess } = require('../../vis/redact');
const { serverError } = require('../../helpers/response');
const { toIsoOrNull } = require('../../seed/transform');
const { logger } = require('../../utils/logger');

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
  multiValueFilters: ['projectId', 'type'],
  ranges: {
    dateAddedStart: { field: 'dateAdded', op: 'ge' },
    dateAddedEnd: { field: 'dateAdded', op: 'le' }
  },
  presence: { hasDocumentUrl: 'documentUrl' },
  flags: { complianceAndEnforcement: 'complianceAndEnforcement' },
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
 * One kind's decision rows as feed rows, `feedDate` from `decisionDate`. A row whose date is hidden
 * or unparseable is dropped, the latter logged: one bad mirrored date must not fail the home page.
 */
function decisionRows(entity, rows, access) {
  const dated = redactAllForAccess(entity, rows, access)
    .map(row => ({ ...row, kind: entity, feedDate: toIsoOrNull(row.decisionDate) }));
  const bad = dated.filter(row => row.decisionDate && !row.feedDate).map(row => String(row.id));
  if (bad.length > 0) logger.warn('[updates] feed dropped decisions with an unparseable decisionDate', { kind: entity, ids: bad });
  return dated.filter(row => row.feedDate);
}

const byFeedDateDesc = (a, b) => (Date.parse(b.feedDate) || 0) - (Date.parse(a.feedDate) || 0);

/**
 * `GET /updates/feed`: the home page feed, `limit` rows in all (default `updates.TOP_ROWS`, at most
 * FEED_MAX_ROWS). Pinned updates lead; the other updates, project decisions and notification
 * decisions follow by `feedDate`, newest first. Each row keeps its own entity's shape plus `kind`
 * and `feedDate`. `type` narrows the unpinned updates only, as `updates.listTop` does.
 */
exports.getFeed = async (req, res) => {
  try {
    const access = resolveAccess(req);
    if (access.authenticated) res.setHeader('cache-control', NO_STORE);

    const { limit, types, error } = parseFeedQuery(req.query, access);
    if (error) return res.status(400).json({ error });

    const now = new Date();
    const [top, projectDecisions, notificationDecisions] = await Promise.all([
      updates.listTop(access, { limit, types }),
      projects.listDecisions(access, { limit, now }),
      notifications.listDecisions(access, { limit, now })
    ]);

    const updateRows = (await updateParentJoin(access, redactAllForAccess(SPEC.entity, top, access)))
      .map(row => ({ ...row, kind: 'updates', feedDate: toIsoOrNull(updates.publishedAt(row)) }));
    // `listTop` answers its pinned rows first; they hold their place, the rest compete on date.
    const pinnedCount = top.filter(row => row.pinned === true).length;
    const rest = [
      ...updateRows.slice(pinnedCount),
      ...decisionRows('projects', projectDecisions, access),
      ...decisionRows('notifications', notificationDecisions, access)
    ].sort(byFeedDateDesc).slice(0, limit - pinnedCount);
    return res.json([...updateRows.slice(0, pinnedCount), ...rest]);
  } catch (err) {
    return serverError(res, err, 'updates feed failed');
  }
};
