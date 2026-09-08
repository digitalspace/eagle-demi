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
 * The precedence rule, said once for every caller: A NOTIFICATION WINS OVER A PROJECT ROW.
 *
 * The two id spaces do not overlap in Eagle, but they do collide in DEMI. A Track project may
 * carry a `ProjectNotification` `_id` in its `epic_guid`, and the merge copies that guid onto the
 * project row's `eagleId` (`merge/project.js:mergeTrackProject`), so a lookup by eagle id answers
 * with a project for a ref that names a notification. Measured 2026-09-08: Track projects 351 and
 * 353 on test, 361 and 378 on dev. Letting the project win filed every period and document under
 * those notifications beneath the Track project — its partition, and its ACL, which is level 2
 * because a Track project with no Eagle counterpart is not public — and the comments cascaded to
 * `['staff']` behind them.
 *
 * The project row itself stays: a Track project with no Eagle counterpart is retained and flagged,
 * never dropped. It just may not claim children that name a notification.
 *
 * Pure, so the seed and the reconcile apply the same rule to rows they already hold.
 *
 * @param {{id: string, read: string[]}|null} project       project row matched by eagle id
 * @param {{id: string, read: string[]}|null} notification  notification row of that same id
 * @returns {{id: string, read: string[], kind: 'project'|'notification'}|null}
 */
function pickParent(project, notification) {
  if (notification) {
    return { id: String(notification.id), read: notification.read, kind: 'notification' };
  }
  if (project) return { id: String(project.id), read: project.read, kind: 'project' };
  return null;
}

/**
 * @param {string|object|null} ref  Eagle's `doc.project`, populated or bare
 * @returns {Promise<{id: string, read: string[], kind: 'project'|'notification'}|null>} the DEMI
 *   parent id to partition the child under, the ACL to read against `kind`, or null when DEMI
 *   holds no such parent
 */
async function admitParent(ref) {
  const eagleId = refId(ref);
  if (!eagleId) return null;

  // BOTH reads, always, and concurrently. The notification decides, so a project hit may not end
  // the lookup early; issuing them together keeps a push at one round trip and costs one extra
  // point read — the notifications container is keyed on that id, so it is the cheapest read there
  // is. The previous order, project first and notification only on a miss, is what let a Track
  // project's dangling guid claim a notification's children.
  //
  // systemAccess on both: a mirror must find a private parent, or it would drop the row and
  // report it as drift the moment Eagle unpublished the project.
  const [project, notification] = await Promise.all([
    projects.getByEagleId(systemAccess(), eagleId),
    notifications.getById(systemAccess(), eagleId)
  ]);

  return pickParent(project, notification);
}

module.exports = { admitParent, pickParent };
