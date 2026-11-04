'use strict';

/** Project group writes; rules in docs/eagle-api-port.md, Project groups. */

const crypto = require('node:crypto');

const groups = require('../repositories/groups');
const projects = require('../repositories/projects');
const { eagleReadUnder } = require('../helpers/eagle-acl');
const { constrainToProject, DELETED_CEILING } = require('../repositories/documents');
const { refusedWriteKeys } = require('../vis/redact');
const { check } = require('./_schema');
const { writeRow } = require('./_write');
const { logger } = require('../utils/logger');

/** eagle-api's group ACL (projectGroup.js:22-24). Never public: a group lists people. */
const GROUP_READ = Object.freeze(['project-system-admin', 'sysadmin', 'staff']);

const NAME = { type: 'string', max: 500 };

/** eagle-api's PUT applies the whole body (projectGroup.js:48); DEMI takes the name only. */
const UPDATE_SCHEMA = Object.freeze({ name: NAME });

/** eagle-api's POST takes `{ group }` as the name under the project in the path (projectGroup.js:21). */
const CREATE_SCHEMA = Object.freeze({
  projectId: { type: 'string', max: 200, required: true },
  name: NAME
});

/** eagle-api's body is a bare array of user ids (projectGroup.js:89); DEMI's is `{ members }`. */
const MEMBERS_SCHEMA = Object.freeze({ members: { type: 'idArray', max: 100, required: true } });

const USER_ID_SCHEMA = Object.freeze({ userId: { type: 'id', required: true } });

const actorOf = (ctx) => (ctx.req.user && ctx.req.user.preferred_username) || '';
const readGroup = (ctx, id) => groups.getById(ctx.access, id);
const membersOf = (row) => (Array.isArray(row.members) ? row.members.map(String) : []);

function auditOf(action, detail) {
  return (saved) => ({
    action, targetType: 'group', targetId: saved.id, projectId: saved.projectId, ...(detail && { detail })
  });
}

/** A write stamped with the caller and the time. */
function stamped(ctx, row) {
  return { ...row, updatedBy: actorOf(ctx), dateUpdated: new Date().toISOString() };
}

/**
 * The row a DEMI write leaves, owned by DEMI so the Eagle mirror stops replacing it. The cascade
 * reads `sources.demi.read`, so a mirrored row keeps Eagle's own read, less `public`.
 */
function ownedByDemi(row) {
  if (row.sourceSystem === 'demi') return row;
  const eagleRead = row.sources && row.sources.eagle && row.sources.eagle.read;
  const own = (Array.isArray(eagleRead) ? eagleRead : []).filter((role) => role !== 'public');
  // No stored Eagle read, or only `public`, takes eagle-api's group ACL.
  const read = own.length ? own : GROUP_READ;
  return { ...row, sourceSystem: 'demi', sources: { ...row.sources, demi: { read } } };
}

/** A DEMI write: owned by DEMI, stamped with the caller and the time. */
const demiWrite = (ctx, row) => stamped(ctx, ownedByDemi(row));

/**
 * @param {{access: object, req: object}} ctx
 * @param {object} input `{ projectId, name? }`
 */
async function create(ctx, input) {
  const checked = check(CREATE_SCHEMA, input);
  if (checked.status !== 'ok') return checked;
  const { projectId, name = '' } = checked.value;

  // The caller's access: a project they cannot read answers as one DEMI does not hold.
  const project = await projects.getById(ctx.access, projectId);
  if (!project) {
    logger.warn('[Group] create refused: unknown project', { projectId });
    return { status: 'invalid', fields: { projectId: 'must name a project' } };
  }

  const id = crypto.randomUUID();
  const actor = actorOf(ctx);
  const now = new Date().toISOString();
  const read = eagleReadUnder(GROUP_READ, project.read);
  const row = {
    id,
    eagleId: null,
    projectId: String(project.id),
    sourceSystem: 'demi',
    name,
    members: [],
    links: [],
    addedBy: actor,
    updatedBy: actor,
    dateAdded: now,
    dateUpdated: now,
    isDeleted: false,
    isPublished: read.includes('public'),
    read,
    // The project cascade re-derives a DEMI row from this, as it does a mirrored one from its Eagle copy.
    sources: { demi: { read: [...GROUP_READ] } }
  };

  return writeRow({
    ctx,
    repo: groups,
    existing: null,
    reread: () => readGroup(ctx, id),
    build: () => row,
    audit: auditOf('group.create', { fields: Object.keys(checked.value) })
  });
}

/**
 * @param {{access: object, req: object}} ctx
 * @param {string} id
 * @param {object} changes `{ name }`
 */
async function update(ctx, id, changes) {
  const checked = check(UPDATE_SCHEMA, changes, { partial: true });
  if (checked.status !== 'ok') return checked;
  const fields = Object.keys(checked.value);
  if (fields.length === 0) return { status: 'invalid', fields: { body: 'must name at least one field' } };

  const existing = await readGroup(ctx, id);
  if (!existing) return { status: 'not-found' };

  const refused = refusedWriteKeys(groups.CONTAINER, checked.value, ctx.access, existing);
  if (refused.length) {
    return { status: 'invalid', fields: Object.fromEntries(refused.map(key => [key, 'is not writable by this caller'])) };
  }

  return writeRow({
    ctx,
    repo: groups,
    existing,
    reread: () => readGroup(ctx, id),
    build: (current) => current && demiWrite(ctx, { ...current, ...checked.value }),
    audit: auditOf('group.update', { fields })
  });
}

/**
 * Hard delete, as eagle-api's `findOneAndDelete` (projectGroup.js:68), on the revision read. A group
 * with an Eagle id is kept flagged and owned by DEMI instead, so a later Eagle push cannot bring it back.
 */
async function remove(ctx, id) {
  const existing = await readGroup(ctx, id);
  if (!existing) return { status: 'not-found' };

  return writeRow({
    ctx,
    repo: {
      upsert: async (row, current) => {
        if (row.isDeleted) return groups.upsert(row, current);
        await groups.deleteById(row.id, row.projectId, row._etag);
        return row;
      }
    },
    existing,
    reread: () => readGroup(ctx, id),
    build: (current) => current && (current.eagleId ? demiWrite(ctx, {
      ...current,
      isDeleted: true,
      isPublished: false,
      read: constrainToProject(current.read, DELETED_CEILING)
    }) : current),
    audit: auditOf('group.delete')
  });
}

/**
 * eagle-api pushes the ids as given (projectGroup.js:92-95), so a member could appear twice; DEMI
 * adds only ids the group does not hold yet. A body that adds nothing writes nothing.
 */
async function addMembers(ctx, id, input) {
  const checked = check(MEMBERS_SCHEMA, input);
  if (checked.status !== 'ok') return checked;

  const existing = await readGroup(ctx, id);
  if (!existing) return { status: 'not-found' };

  const newIn = (current) => {
    const held = new Set(membersOf(current));
    return [...new Set(checked.value.members)].filter(member => !held.has(member));
  };
  const added = newIn(existing);
  if (added.length === 0) return { status: 'ok', value: existing };

  return writeRow({
    ctx,
    repo: groups,
    existing,
    reread: () => readGroup(ctx, id),
    // Recomputed on the row a lost race re-read, so a concurrent add is neither lost nor doubled.
    build: (current) => current && demiWrite(ctx, { ...current, members: [...membersOf(current), ...newIn(current)] }),
    audit: auditOf('group.addMembers', { userIds: added })
  });
}

/** eagle-api's `$pull` (projectGroup.js:190-193). Removing an id the group does not hold writes nothing. */
async function removeMember(ctx, id, userId) {
  const checked = check(USER_ID_SCHEMA, { userId });
  if (checked.status !== 'ok') return checked;

  const existing = await readGroup(ctx, id);
  if (!existing) return { status: 'not-found' };
  if (!membersOf(existing).includes(userId)) return { status: 'ok', value: existing };

  return writeRow({
    ctx,
    repo: groups,
    existing,
    reread: () => readGroup(ctx, id),
    build: (current) => current && demiWrite(ctx, {
      ...current, members: membersOf(current).filter(member => member !== userId)
    }),
    audit: auditOf('group.removeMember', { userIds: [userId] })
  });
}

module.exports = {
  GROUP_READ, CREATE_SCHEMA, UPDATE_SCHEMA, MEMBERS_SCHEMA, create, update, remove, addMembers, removeMember
};
