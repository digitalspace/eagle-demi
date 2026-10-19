'use strict';

/**
 * Organization writes: `POST /organizations`, `PUT /organizations/:id`, and publish and unpublish
 * on `/organizations/:id`, ported from eagle-api
 * `api/controllers/organization.js` (rules in docs/eagle-api-port.md, Organizations). Rows live in
 * the `lists` container as `kind: 'Organization'`, beside the ones the Eagle mirror writes.
 */

const crypto = require('node:crypto');

const lists = require('../repositories/lists');
const users = require('../repositories/users');
const { systemAccess } = require('../helpers/access-sql');
const { writeGuarded } = require('../helpers/etag-write');
const { refusedWriteKeys } = require('../vis/redact');
const { check, without } = require('./_schema');
const { writeRow, readWith, STAFF_READ, PUBLIC_READ } = require('./_write');
const { logger } = require('../utils/logger');

const SHORT = { type: 'string', max: 1000 };

/** The fields eagle-api's POST copies from the body (organization.js:92-113). None is required. */
const SCHEMA = Object.freeze({
  name: SHORT,
  description: { type: 'string', max: 10000 },
  country: SHORT,
  postal: SHORT,
  province: SHORT,
  city: SHORT,
  address1: SHORT,
  address2: SHORT,
  companyType: SHORT,
  companyLegal: SHORT,
  company: SHORT,
  parentCompany: { type: 'id', nullable: true }
});

/** Create adds `isPublished`, which eagle-api did not take: it published every new organization. */
const CREATE_SCHEMA = Object.freeze({ ...SCHEMA, isPublished: { type: 'boolean' } });

/** Visibility moves only through publish and unpublish, so a body's `read` and `isPublished` are dropped. */
const IGNORED_ON_UPDATE = ['read', 'isPublished'];

const readOrg = (ctx, id) => lists.getById(ctx.access, id, lists.KINDS.ORGANIZATION);

const actorOf = (ctx) => (ctx.req.user && ctx.req.user.preferred_username) || '';

/** True when `value` passes the parentCompany spec on its own. */
const validParent = (value) =>
  check({ parentCompany: SCHEMA.parentCompany }, { parentCompany: value }).status === 'ok';

/**
 * eagle-api stores a parentCompany that is not an id as null, without an error (organization.js:107).
 * Create only: its PUT fails the cast instead, so `update` keeps the schema's 400.
 */
function coerceParent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  if (!Object.hasOwn(input, 'parentCompany') || validParent(input.parentCompany)) return input;
  return { ...input, parentCompany: null };
}

function auditOf(action, fields) {
  return (saved) => ({ action, targetType: 'organization', targetId: saved.id, detail: { fields } });
}

/**
 * @param {{access: object, req: object}} ctx
 * @param {object} input the request body; `read` is ignored, `isPublished` defaults to false
 */
async function create(ctx, input) {
  const checked = check(CREATE_SCHEMA, coerceParent(without(input, ['read'])));
  if (checked.status !== 'ok') return checked;
  const { isPublished = false, ...fields } = checked.value;

  const id = crypto.randomUUID();
  const actor = actorOf(ctx);
  const now = new Date().toISOString();
  const read = [...(isPublished ? PUBLIC_READ : STAFF_READ)];
  const row = {
    id,
    eagleId: null,
    kind: lists.KINDS.ORGANIZATION,
    sourceSystem: 'demi',
    ...Object.fromEntries(Object.keys(SCHEMA).map(key => [key, key === 'parentCompany' ? null : ''])),
    ...fields,
    addedBy: actor,
    updatedBy: actor,
    dateAdded: now,
    dateUpdated: now,
    isPublished: read.includes('public'),
    read
  };

  return writeRow({
    ctx,
    repo: lists,
    existing: null,
    reread: () => readOrg(ctx, id),
    build: () => row,
    audit: auditOf('organization.create', Object.keys(checked.value))
  });
}

/**
 * @param {{access: object, req: object}} ctx
 * @param {string} id
 * @param {object} changes the request body, any subset of SCHEMA; `read` and `isPublished` are ignored
 */
async function update(ctx, id, changes) {
  const checked = check(SCHEMA, without(changes, IGNORED_ON_UPDATE), { partial: true });
  if (checked.status !== 'ok') return checked;
  const fields = Object.keys(checked.value);
  if (fields.length === 0) return { status: 'invalid', fields: { body: 'must name at least one field' } };

  const existing = await readOrg(ctx, id);
  if (!existing) return { status: 'not-found' };

  const refused = refusedWriteKeys(lists.CONTAINER, checked.value, ctx.access, existing);
  if (refused.length) {
    return { status: 'invalid', fields: Object.fromEntries(refused.map(key => [key, 'is not writable by this caller'])) };
  }

  const actor = actorOf(ctx);
  const written = await writeRow({
    ctx,
    repo: lists,
    existing,
    reread: () => readOrg(ctx, id),
    build: (current) => current && {
      ...current, ...checked.value, updatedBy: actor, dateUpdated: new Date().toISOString()
    },
    audit: auditOf('organization.update', fields)
  });

  // A nameless organization gives no orgName to compare, so its users are left alone.
  if (written.status === 'ok' && typeof written.value.name === 'string') {
    await renameUsers(id, written.value.name);
  }
  return written;
}

/**
 * eagle-api renames `orgName` on every user of the organization (organization.js:163). The org row
 * is already saved, so a failed cascade is logged, not returned. Any later PUT of the organization
 * repairs it, because each user's orgName is compared with the organization name rather than
 * checking whether the name changed.
 */
async function renameUsers(orgId, orgName) {
  let updated = 0;
  let failed = 0;

  const access = systemAccess();
  let members;
  try {
    members = await users.listByOrg(access, orgId);
  } catch (err) {
    logger.warn('[Organization] users not listed, orgName not renamed', {
      orgId, error: err.message, stack: err.stack
    });
    return;
  }
  for (const user of members) {
    if (user.orgName === orgName) continue;
    try {
      const written = await writeGuarded({
        existing: user,
        reread: () => users.getById(access, user.id),
        attempt: async (current) => {
          // Deleted since the list was read: nothing to rename.
          if (!current) return { status: 'gone' };
          return { status: 'ok', saved: await users.upsert({ ...current, orgName }, current) };
        }
      });
      if (written.status === 'conflict') throw new Error('every write of the user lost its etag race');
      if (written.status === 'ok') updated++;
    } catch (err) {
      failed++;
      logger.warn('[Organization] orgName not renamed on user', {
        userId: user.id, orgId, error: err.message, stack: err.stack
      });
    }
  }

  if (updated || failed) logger.info('[Organization] orgName renamed on users', { orgId, updated, failed });
}

/**
 * eagle-api `Actions.publish` and `unPublish` (actions.js:7,31) on an organization. No ceiling: an
 * organization is not project data, so nothing above it caps its read.
 */
function setPublished(published) {
  const action = published ? 'organization.publish' : 'organization.unpublish';
  return async function (ctx, id) {
    const actor = actorOf(ctx);
    // A missing row reaches `build` as null, which writeRow answers as not-found.
    return writeRow({
      ctx,
      repo: lists,
      existing: await readOrg(ctx, id),
      reread: () => readOrg(ctx, id),
      build: (current) => current && {
        ...current,
        isPublished: published,
        read: readWith(current.read, published),
        updatedBy: actor,
        dateUpdated: new Date().toISOString()
      },
      audit: auditOf(action, ['isPublished'])
    });
  };
}

module.exports = {
  SCHEMA,
  create,
  update,
  publish: setPublished(true),
  unpublish: setPublished(false)
};
