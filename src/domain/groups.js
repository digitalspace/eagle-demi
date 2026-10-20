'use strict';

/**
 * Project group writes: `POST /groups`, `PUT` and `DELETE /groups/:id`, and adding and removing
 * members on `/groups/:id/members`, ported from eagle-api `api/controllers/projectGroup.js` (rules
 * in docs/eagle-api-port.md, Project groups).
 */

const crypto = require('node:crypto');

const groups = require('../repositories/groups');
const projects = require('../repositories/projects');
const { eagleReadUnder } = require('../helpers/eagle-acl');
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
    build: (current) => current && stamped(ctx, { ...current, ...checked.value }),
    audit: auditOf('group.update', { fields })
  });
}

/** Hard delete, as eagle-api's `findOneAndDelete` (projectGroup.js:68), on the revision read. */
async function remove(ctx, id) {
  const existing = await readGroup(ctx, id);
  if (!existing) return { status: 'not-found' };

  return writeRow({
    ctx,
    repo: {
      upsert: async (row) => {
        await groups.deleteById(row.id, row.projectId, row._etag);
        return row;
      }
    },
    existing,
    reread: () => readGroup(ctx, id),
    build: (current) => current,
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
    build: (current) => current && stamped(ctx, { ...current, members: [...membersOf(current), ...newIn(current)] }),
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
    build: (current) => current && stamped(ctx, {
      ...current, members: membersOf(current).filter(member => member !== userId)
    }),
    audit: auditOf('group.removeMember', { userIds: [userId] })
  });
}

module.exports = {
  GROUP_READ, CREATE_SCHEMA, UPDATE_SCHEMA, MEMBERS_SCHEMA, create, update, remove, addMembers, removeMember
};
