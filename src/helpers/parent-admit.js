'use strict';

/**
 * Resolve the Eagle parent a mirrored row hangs off — a project, or a `ProjectNotification`.
 *
 * Eagle's `project` reference is not a project id. A `CommentPeriod` or a `Document` may carry a
 * `ProjectNotification` `_id` there instead, and prod serves published documents and periods under
 * those. Resolving through `projects.getByEagleId` alone answers null for every one of them, and
 * the mirrors then drop the row — measured on test 2026-09-07: 10 comment periods and the 232
 * comments under them.
 *
 * ADMITTED BY KNOWN ROW, never by "the ref resolved to nothing": a ref in neither container is a
 * row with no home and its caller drops it. Same rule `seed-nosql.js:documentAdmission` applies to
 * the seed, said against Cosmos rather than against the Eagle fetch, because a push has no fetch.
 *
 * `kind` is what the caller narrows on. A project parent is a CEILING — a child may never out-rank
 * it — while a notification is not: it has no project ACL to narrow against, so its children keep
 * their own `read[]` verbatim (`seed/transform.js`, the notification-parented branch).
 */

const projects = require('../repositories/projects');
const notifications = require('../repositories/notifications');
const { systemAccess } = require('./access-sql');
// Dependency-free reference parser shared with every mirror, so a populated `{_id}` and a bare
// ObjectId resolve here exactly as they do there.
const { refId } = require('../controllers/nosql/eagle-mirror');

/**
 * @param {string|object|null} ref  Eagle's `doc.project`, populated or bare
 * @returns {Promise<{id: string, read: string[], kind: 'project'|'notification'}|null>} the DEMI
 *   parent id to partition the child under, the ACL to read against `kind`, or null when DEMI
 *   holds no such parent
 */
async function admitParent(ref) {
  const eagleId = refId(ref);
  if (!eagleId) return null;

  // systemAccess on both reads: a mirror must find a private parent, or it would drop the row and
  // report it as drift the moment Eagle unpublished the project.
  const project = await projects.getByEagleId(systemAccess(), eagleId);
  if (project) return { id: String(project.id), read: project.read, kind: 'project' };

  // Only when there is no project row. The two id spaces do not overlap, and a project is the
  // common case by four orders of magnitude.
  const notification = await notifications.getById(systemAccess(), eagleId);
  if (notification) {
    return { id: String(notification.id), read: notification.read, kind: 'notification' };
  }

  return null;
}

module.exports = { admitParent };
