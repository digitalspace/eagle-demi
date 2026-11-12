'use strict';

/**
 * Eagle mirror for `Group`, the only writer of `groups`; a group never out-ranks its project. A
 * deleted group is kept and narrowed to level 2; a DEMI-owned group takes only the raw copy.
 */

const groups = require('../../repositories/groups');
const { eagleReadUnder } = require('../../seed/transform');
const { admitParent, refusalCode } = require('../../helpers/parent-admit');
const { upsertKeepingDemiRows, pushHandler, underDeleteCeiling, refId } = require('./eagle-mirror');
const { listHandler, getHandler } = require('./mirror-reads');
const { projectParentJoin } = require('../../helpers/native-query');

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
  const written = await upsertKeepingDemiRows(
    groups, eagleId, doc,
    (current) => mirrorItem(eagleId, doc, parent.id, read, current),
    () => groups.readForWrite(eagleId, parent.id),
    { pushedAt, label: LABEL }
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

exports.upsertFromEagle = pushHandler({
  label: LABEL, action: 'group.push', targetType: 'group', mirror: mirrorFromEagle, projectScoped: true,
  refuse: (written, doc, res) => !written
    && res.status(404).json({ error: 'Parent project not found', code: refusalCode(doc.project) }),
  detail: (saved, _existing, eagleId) => ({ eagleId, isDeleted: saved.isDeleted }),
  failure: 'group controller failed'
});

const GROUPS = {
  entity: 'groups',
  repository: groups.native,
  sortKeys: ['name'],
  filters: ['projectId'],
  aliases: { project: 'projectId' },
  qFields: ['name'],
  parentJoin: projectParentJoin,
  notFound: 'Group not found'
};

exports.nativeSpec = GROUPS;
exports.getGroups = listHandler(GROUPS);
exports.getGroup = getHandler(GROUPS);
