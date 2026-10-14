'use strict';

/**
 * Organization writes: `POST /organizations` and `PUT /organizations/:id`, ported from eagle-api
 * `api/controllers/organization.js` (rules in docs/eagle-api-port.md, Organizations). Rows live in
 * the `lists` container as `kind: 'Organization'`, beside the ones the Eagle mirror writes.
 */

const crypto = require('node:crypto');

const lists = require('../repositories/lists');
const users = require('../repositories/users');
const { systemAccess } = require('../helpers/access-sql');
const { eagleBaseAcl } = require('../helpers/eagle-acl');
const { writeGuarded } = require('../helpers/etag-write');
const { refusedWriteKeys } = require('../vis/redact');
const { check } = require('./_schema');
const { writeRow } = require('./_write');
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

/** Every new organization reads like eagle-api's: public, staff, sysadmin (organization.js:110). */
const NEW_READ = Object.freeze(['public', 'staff', 'sysadmin']);

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
 * @param {object} input the request body
 */
async function create(ctx, input) {
  const checked = check(SCHEMA, coerceParent(input));
  if (checked.status !== 'ok') return checked;

  const id = crypto.randomUUID();
  const actor = actorOf(ctx);
  const now = new Date().toISOString();
  const read = eagleBaseAcl(NEW_READ);
  const row = {
    id,
    eagleId: null,
    kind: lists.KINDS.ORGANIZATION,
    sourceSystem: 'demi',
    ...Object.fromEntries(Object.keys(SCHEMA).map(key => [key, key === 'parentCompany' ? null : ''])),
    ...checked.value,
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
 * @param {object} changes the request body, any subset of SCHEMA
 */
async function update(ctx, id, changes) {
  const checked = check(SCHEMA, changes, { partial: true });
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

module.exports = { SCHEMA, create, update };
