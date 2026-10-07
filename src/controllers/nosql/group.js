'use strict';

/**
 * Group controller — the Eagle mirror for `Group`, a project's contact group, and the only writer
 * of `groups`.
 *
 * A group may never out-rank its project, so its read is derived under the project's through
 * `eagleReadUnder`, as a comment period's is. eagle-api hard-deletes a group and pushes the removed
 * record with `isDeleted: true`; the row is kept, flagged, and narrowed to level 2.
 */

const groups = require('../../repositories/groups');
const { eagleReadUnder } = require('../../seed/transform');
const { mirrorError } = require('../../helpers/duplicate-id');
const { auditEvent } = require('../../utils/audit');
const { admitParent, refusalCode } = require('../../helpers/parent-admit');
const {
  eaglePush, upsertWithRetry, ignoreStalePush, pushConflict, underDeleteCeiling, refId
} = require('./eagle-mirror');
const { listHandler, getHandler } = require('./mirror-reads');

const LABEL = 'Group Controller';

function mirrorItem(eagleId, doc, projectId, read, existing) {
  return {
    id: eagleId,
    eagleId,
    projectId: String(projectId),
    sourceSystem: 'eagle',

    name: doc.name || '',
    members: Array.isArray(doc.members) ? doc.members.map(refId).filter(Boolean) : [],
    links: Array.isArray(doc.links) ? doc.links : [],

    isDeleted: doc.isDeleted === true,
    isPublished: read.includes('public'),
    read,
    sources: { ...(existing && existing.sources), eagle: doc }
  };
}

/** NULL when the parent project is not in DEMI. */
async function mirrorFromEagle(eagleId, doc, { pushedAt = null } = {}) {
  const parent = await admitParent(doc.project, { childId: eagleId });
  if (!parent) return null;

  const read = underDeleteCeiling(eagleReadUnder(doc.read, parent.read), doc);
  const written = await upsertWithRetry(
    groups,
    (current) => mirrorItem(eagleId, doc, parent.id, read, current),
    () => groups.readForWrite(eagleId, parent.id),
    { pushedAt }
  );
  if (written.status === 'conflict' || written.ignored) return written;
  const { saved, existing } = written;

  // Moved project: the old partition still holds a listable copy.
  if (existing && String(existing.projectId) !== saved.projectId) {
    await groups.deleteById(existing.id, existing.projectId);
  }
  return { saved, existing };
}

exports.mirrorFromEagle = mirrorFromEagle;

exports.upsertFromEagle = async (req, res) => {
  try {
    const push = eaglePush(req);
    if (!push) {
      return res.status(400).json({ error: 'body.doc._id must match the :eagleId in the path' });
    }
    const { eagleId, doc, pushedAt } = push;

    const written = await mirrorFromEagle(eagleId, doc, { pushedAt });
    if (!written) {
      return res.status(404).json({ error: 'Parent project not found', code: refusalCode(doc.project) });
    }
    if (written.status === 'conflict') return pushConflict(res, { label: LABEL, eagleId });
    const { saved, existing, ignored } = written;
    if (ignored) {
      return ignoreStalePush(req, res, {
        label: LABEL, action: 'group.push', targetType: 'group',
        current: existing, projectId: existing.projectId, pushedAt
      });
    }

    auditEvent(req, {
      action: 'group.push',
      targetType: 'group',
      targetId: saved.id,
      projectId: saved.projectId,
      detail: { eagleId, isDeleted: saved.isDeleted }
    });
    return res.json({ id: saved.id, action: 'upsert' });
  } catch (err) {
    return mirrorError(res, err, 'group controller failed');
  }
};

exports.getGroups = listHandler('groups',
  (access, query, page) => groups.listVisible(access, { projectId: query.project, ...page }));
exports.getGroup = getHandler('groups', 'Group not found',
  (access, id, query) => groups.getById(access, id, query.project));
