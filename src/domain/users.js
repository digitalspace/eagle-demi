'use strict';

/**
 * User writes: `POST /users` and `PUT /users/:id`, ported from eagle-api `api/controllers/user.js`
 * (rules in docs/eagle-api-port.md, Users). Rows live in the `users` container beside the ones
 * the Eagle mirror writes (controllers/nosql/user.js).
 */

const crypto = require('node:crypto');

const users = require('../repositories/users');
const { refusedWriteKeys } = require('../vis/redact');
const { check, without } = require('./_schema');
const { writeRow, readWith, STAFF_READ, PUBLIC_READ } = require('./_write');

/** eagle-api lets only this organization's users read public (user.js:39,92). */
const PUBLIC_ORG_NAME = 'Environmental Assessment Office';

const TEXT = { type: 'string', max: 1000, nullable: true };

/** The fields eagle-api's POST and PUT copy from the body (user.js:18-38,69-90). None is required. */
const SCHEMA = Object.freeze({
  firstName: TEXT,
  middleName: TEXT,
  lastName: TEXT,
  displayName: TEXT,
  email: TEXT,
  org: { type: 'id', nullable: true },
  orgName: TEXT,
  title: TEXT,
  phoneNumber: TEXT,
  salutation: TEXT,
  department: TEXT,
  faxNumber: TEXT,
  cellPhoneNumber: TEXT,
  address1: TEXT,
  address2: TEXT,
  city: TEXT,
  province: TEXT,
  country: TEXT,
  postalCode: TEXT,
  notes: { type: 'string', max: 10000, nullable: true }
});

const FIELDS = Object.keys(SCHEMA);

/**
 * What a field missing from the body becomes. eagle-api writes '' (user.js:69-90); its push stores
 * `null` for `middleName` and `org` (controllers/nosql/user.js), so a DEMI row reads the same.
 */
const DEFAULTS = Object.freeze({
  ...Object.fromEntries(FIELDS.map(key => [key, ''])),
  middleName: null,
  org: null
});

/** `isPublished` replaces eagle-api's public-by-orgName read; `read` itself is never taken from a body. */
const BODY_SCHEMA = Object.freeze({ ...SCHEMA, isPublished: { type: 'boolean' } });

const readUser = (ctx, id) => users.getById(ctx.access, id);

const actorOf = (ctx) => (ctx.req.user && ctx.req.user.preferred_username) || '';

/** Every field, missing or empty ones defaulted: eagle-api's `value ? value : ''`. */
function replaced(value) {
  return Object.fromEntries(FIELDS.map(key => [key, value[key] || DEFAULTS[key]]));
}

/** A public user outside eagle-api's one public organization is refused rather than quietly narrowed. */
function publicRefused(isPublished, orgName) {
  return isPublished === true && orgName !== PUBLIC_ORG_NAME
    ? { status: 'invalid', fields: { isPublished: `only a user whose orgName is '${PUBLIC_ORG_NAME}' can be public` } }
    : null;
}

function auditOf(action, fields) {
  return (saved) => ({ action, targetType: 'user', targetId: saved.id, detail: { fields } });
}

/**
 * @param {{access: object, req: object}} ctx
 * @param {object} input the request body; `read` is ignored, `isPublished` defaults to false
 */
async function create(ctx, input) {
  const checked = check(BODY_SCHEMA, without(input, ['read']));
  if (checked.status !== 'ok') return checked;
  const { isPublished = false, ...fields } = checked.value;
  const next = replaced(fields);
  const refused = publicRefused(isPublished, next.orgName);
  if (refused) return refused;

  const id = crypto.randomUUID();
  const actor = actorOf(ctx);
  const now = new Date().toISOString();
  const read = [...(isPublished ? PUBLIC_READ : STAFF_READ)];
  const row = {
    id,
    eagleId: null,
    sourceSystem: 'demi',
    ...next,
    addedBy: actor,
    updatedBy: actor,
    dateAdded: now,
    dateUpdated: now,
    isPublished: read.includes('public'),
    read
  };

  // eagle-api audits this create as 'Put' (user.js:49); DEMI names it user.create.
  return writeRow({
    ctx,
    repo: users,
    existing: null,
    reread: () => readUser(ctx, id),
    build: () => row,
    audit: auditOf('user.create', Object.keys(checked.value))
  });
}

/**
 * Replaces every field, as eagle-api's PUT does (user.js:69-90); a field the body leaves out goes
 * back to its default. `isPublished` left out keeps the current visibility, except that a user
 * whose orgName moves off the public organization loses public, as eagle-api's PUT does (:92).
 *
 * @param {{access: object, req: object}} ctx
 * @param {string} id
 * @param {object} changes the request body; `read` is ignored
 */
async function update(ctx, id, changes) {
  const checked = check(BODY_SCHEMA, without(changes, ['read']));
  if (checked.status !== 'ok') return checked;
  const { isPublished, ...fields } = checked.value;
  const given = Object.keys(fields);
  if (given.length === 0) return { status: 'invalid', fields: { body: 'must name at least one field besides isPublished' } };

  const next = replaced(fields);
  const refusedPublic = publicRefused(isPublished, next.orgName);
  if (refusedPublic) return refusedPublic;

  const existing = await readUser(ctx, id);
  if (!existing) return { status: 'not-found' };

  const refused = refusedWriteKeys(users.CONTAINER, next, ctx.access, existing);
  if (refused.length) {
    return { status: 'invalid', fields: Object.fromEntries(refused.map(key => [key, 'is not writable by this caller'])) };
  }

  const actor = actorOf(ctx);
  return writeRow({
    ctx,
    repo: users,
    existing,
    reread: () => readUser(ctx, id),
    build: (current) => {
      if (!current) return null;
      const wanted = isPublished ?? current.isPublished === true;
      const published = wanted && next.orgName === PUBLIC_ORG_NAME;
      return {
        ...current,
        ...next,
        updatedBy: actor,
        dateUpdated: new Date().toISOString(),
        isPublished: published,
        read: readWith(current.read, published)
      };
    },
    audit: auditOf('user.update', Object.keys(checked.value))
  });
}

module.exports = { SCHEMA, DEFAULTS, PUBLIC_ORG_NAME, create, update };
