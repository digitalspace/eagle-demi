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
 * their own `read[]` minus compliance (`seed/transform.js`, the notification-parented branch).
 *
 * A REFUSAL IS LOGGED: one `parent not admitted` warn per refused child, after one bounded extra
 * read that also admits a project an Eagle push sealed. The 404 body's `code` (`refusalCode`) tells
 * eagle-api whether waiting for the parent can help.
 */

const projects = require('../repositories/projects');
const notifications = require('../repositories/notifications');
const { canRead, systemAccess, levelOfRead, isDemiSeal } = require('./access-sql');
const { eagleBaseAcl } = require('../seed/transform');
const { logger } = require('../utils/logger');
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

/** Reason logged for a ref that is not an Eagle ObjectId; the raw value is never logged. */
const MALFORMED_REF = 'malformed-ref';
/** Reason logged when Eagle sent no parent at all (null, undefined, ''). */
const NO_REF = 'no-ref';

/** Why a ref that `eagleRef` rejected was rejected. */
function badRefReason(ref) {
  return refId(ref) ? MALFORMED_REF : NO_REF;
}

/**
 * How long a refusal waits to learn why before it logs `unknown`. eagle-api aborts a push at 10 s,
 * and the project classify is a cross-partition lookup that may drain many pages.
 */
const CLASSIFY_TIMEOUT_MS = 2000;

const TIMED_OUT = Symbol('timed out or failed');

/** The ref's Eagle id if it is a 24-hex ObjectId, else null: nothing else reaches a read or log. */
function eagleRef(ref) {
  const id = refId(ref);
  return id && projects.EAGLE_OBJECT_ID.test(id) ? id : null;
}

/** 404 `code` for a well-formed ref DEMI holds no admissible parent for; a later push may land it. */
const PARENT_NOT_FOUND = 'PARENT_NOT_FOUND';
/** 404 `code` for a ref that is absent or not an Eagle ObjectId; no parent push can fix it. */
const PARENT_REF_INVALID = 'PARENT_REF_INVALID';

/** The 404 body `code` for a child refused on `ref`. */
function refusalCode(ref) {
  return eagleRef(ref) ? PARENT_NOT_FOUND : PARENT_REF_INVALID;
}

/**
 * A level-0 row an Eagle push sealed (no `sealedAt`) is judged at its Eagle read minus compliance,
 * the read its next push lands. Any other row is judged as stored.
 */
function asPushed(row) {
  if (!row || levelOfRead(row.read) !== 0 || isDemiSeal(row)) return row;
  const eagle = row.sources && row.sources.eagle;
  return { ...row, read: eagleBaseAcl(eagle && eagle.read) };
}

/** The row, at `asPushed`'s read, when the system caller reads it; else null. */
function admissible(row, partitionField) {
  const judged = asPushed(row);
  return judged && canRead(judged, systemAccess(), partitionField) ? judged : null;
}

/**
 * Why a stored parent row did not admit. `hidden` is read-less or DEMI-sealed alike;
 * `eagle-sealed` heals when the parent is pushed again; `visible` means the row landed after the
 * admission read.
 *
 * @returns {'missing'|'hidden'|'eagle-sealed'|'visible'}
 */
function missReason(row, scopeField) {
  if (!row) return 'missing';
  if (canRead(row, systemAccess(), scopeField)) return 'visible';
  return asPushed(row) === row ? 'hidden' : 'eagle-sealed';
}

/**
 * The refusal line. The 404 `code` does not tell "missing" from "hidden"; only this does.
 * `childId` is the refused child's Eagle id, so the lines can feed a targeted repush.
 *
 * @param {{eagleId?: string, childId: string|null}} ids  eagleId is absent for a malformed or missing ref
 * @param {Object<string, string>} reasons  one reason per container, keyed by container role
 */
function warnNotAdmitted(ids, reasons) {
  logger.warn('[parent-admit] parent not admitted', { ...ids, ...reasons });
}

/**
 * Name why a refused parent did not admit, from its unfiltered row. Awaited before the 404, since
 * Functions may drop work after the response; a failed or timed-out read answers `unknown`.
 */
async function classify(readRow, target) {
  const row = await readBounded(readRow, target);
  return row === TIMED_OUT ? 'unknown' : missReason(row, target.partitionField);
}

/**
 * `readRow` raced against `CLASSIFY_TIMEOUT_MS`; `TIMED_OUT` for a failed or timed-out read,
 * which is logged here.
 */
async function readBounded(readRow, { eagleId, container }) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, CLASSIFY_TIMEOUT_MS, TIMED_OUT);
  });
  try {
    const row = await Promise.race([readRow(), timeout]);
    if (row !== TIMED_OUT) return row;
    logger.warn('[parent-admit] could not classify parent',
      { eagleId, container, error: `timed out after ${CLASSIFY_TIMEOUT_MS} ms` });
  } catch (err) {
    logger.error('[parent-admit] could not classify parent',
      { eagleId, container, error: err.message, stack: err.stack });
  } finally {
    clearTimeout(timer);
  }
  return TIMED_OUT;
}

/**
 * On a refusal, logs one `parent not admitted` warn (reasons `missing`, `hidden`, `eagle-sealed`,
 * `visible`, `unknown`, `malformed-ref` or `no-ref`) after one extra project read. A notification hidden
 * behind a same-id project is admitted to the project and logged too. A parent an Eagle push sealed
 * is admitted at its Eagle read minus compliance, and logged.
 *
 * @param {string|object|null} ref  Eagle's `doc.project`, populated or bare
 * @param {{childId?: string}} [child]  the pushed child's Eagle id, for the log
 * @returns {Promise<{id: string, read: string[], kind: 'project'|'notification'}|null>} the DEMI
 *   parent id to partition the child under, the ACL to read against `kind`, or null when DEMI
 *   holds no such parent
 */
async function admitParent(ref, { childId } = {}) {
  const child = { childId: eagleRef(childId) };
  const eagleId = eagleRef(ref);
  if (!eagleId) {
    const reason = badRefReason(ref);
    warnNotAdmitted(child, { project: reason, notification: reason });
    return null;
  }

  // BOTH reads, always, and concurrently. The notification decides, so a project hit may not end
  // the lookup early; issuing them together keeps a push at one round trip and costs one extra
  // point read — the notifications container is keyed on that id, so it is the cheapest read there
  // is. The previous order, project first and notification only on a miss, is what let a Track
  // project's dangling guid claim a notification's children.
  //
  // systemAccess on both: a mirror must find a private parent, or it would drop the row and
  // report it as drift the moment Eagle unpublished the project.
  //
  // Notification read raw and filtered here, as `notifications.getById` does, so a refusal can
  // say why without a second read.
  const [project, notificationRow] = await Promise.all([
    projects.getByEagleId(systemAccess(), eagleId),
    notifications.readForWrite(eagleId)
  ]);
  const notification = admissible(notificationRow, notifications.SCOPE_FIELD);

  let parent = pickParent(project, notification);
  if (!parent) {
    // Accepted cost: the seed-public-reads backfill pays this read once per orphan period too.
    const target = { eagleId, container: projects.CONTAINER, partitionField: projects.PARTITION_FIELD };
    const stored = await readBounded(() => projects.readForWriteByEagleId(eagleId), target);
    // The system read above filters every level-0 row, so an Eagle-sealed project is only seen here.
    const unsealed = stored !== TIMED_OUT && stored !== asPushed(stored)
      ? admissible(stored, target.partitionField)
      : null;
    if (unsealed) {
      parent = pickParent(unsealed, null);
      logger.warn('[parent-admit] project stored sealed by an Eagle push, admitted at its Eagle read',
        { eagleId, ...child, projectId: parent.id });
    } else {
      warnNotAdmitted({ eagleId, ...child }, {
        project: stored === TIMED_OUT ? 'unknown' : missReason(stored, target.partitionField),
        notification: missReason(notificationRow, notifications.SCOPE_FIELD)
      });
    }
  } else if (notification && notification !== notificationRow) {
    logger.warn('[parent-admit] notification stored sealed by an Eagle push, admitted at its Eagle read',
      { eagleId, ...child, notificationId: parent.id });
  } else if (notificationRow && !notification) {
    logger.warn('[parent-admit] hidden notification passed its children to a same-id project',
      { eagleId, ...child, projectId: parent.id });
  }
  return parent;
}

module.exports = {
  admitParent, pickParent, eagleRef, badRefReason, classify, warnNotAdmitted, refusalCode,
  MALFORMED_REF, NO_REF, CLASSIFY_TIMEOUT_MS
};
