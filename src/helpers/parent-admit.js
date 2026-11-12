'use strict';

/**
 * Eagle's `project` ref may name a `ProjectNotification`, not a project; a ref in neither is dropped.
 * A project parent caps its child's `read[]`; a notification does not, it has no project ACL.
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
 * A notification wins over a project row: a Track project's `epic_guid` can hold a notification id,
 * so a lookup by eagle id may answer with a project for a ref that names a notification.
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
 * `eagle-sealed` heals when the parent is pushed again; `visible` means the row landed after the
 * admission read.
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
 * A parent an Eagle push sealed is admitted at its Eagle read minus compliance, and logged.
 * @param {string|object|null} ref  Eagle's `doc.project`, populated or bare
 * @param {{childId?: string}} [child]  the pushed child's Eagle id, for the log
 * @returns {Promise<{id: string, read: string[], kind: 'project'|'notification'}|null>} null when DEMI holds no such parent
 */
async function admitParent(ref, { childId } = {}) {
  const child = { childId: eagleRef(childId) };
  const eagleId = eagleRef(ref);
  if (!eagleId) {
    const reason = badRefReason(ref);
    warnNotAdmitted(child, { project: reason, notification: reason });
    return null;
  }

  // Both reads always: the notification decides, so a project hit may not end the lookup early.
  // systemAccess, else a private parent is missed and its child dropped as drift.
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
