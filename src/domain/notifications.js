'use strict';

/**
 * Project notification writes: `POST /notifications`, `PUT /notifications/:id`, and publish and
 * unpublish on `/notifications/:id`, ported from eagle-api `api/controllers/projectNotification.js`
 * (rules in docs/eagle-api-port.md, Project notifications).
 */

const crypto = require('node:crypto');

const notifications = require('../repositories/notifications');
const updates = require('../repositories/updates');
const { refusedWriteKeys } = require('../vis/redact');
const { check, without } = require('./_schema');
const { writeRow, readWith, STAFF_READ, PUBLIC_READ } = require('./_write');

const SHORT = { type: 'string', max: 1000, nullable: true };
const LONG = { type: 'string', max: 10000, nullable: true };
const DATE = { type: 'isoDate', nullable: true };

/** The fields eagle-api's PUT maps from the body (projectNotification.js:114-135). None is required. */
const SCHEMA = Object.freeze({
  name: SHORT,
  type: SHORT,
  subType: SHORT,
  proponent: SHORT,
  nature: SHORT,
  region: SHORT,
  location: LONG,
  trigger: LONG,
  decision: SHORT,
  decisionDate: DATE,
  notificationReceivedDate: DATE,
  description: LONG,
  notificationThresholdUnits: SHORT,
  associatedProjectId: { type: 'string', max: 200, nullable: true },
  associatedProjectName: SHORT,
  dateStarted: DATE,
  dateCompleted: DATE,
  pcp: { type: 'string', max: 200, nullable: true },
  isMet: { type: 'boolean', nullable: true },
  metURL: { type: 'string', max: 2000, nullable: true }
});

/** Fields `_schema.js` has no type for, checked here: a Number and a Mixed array in the model. */
const NUMBER_FIELDS = Object.freeze({
  notificationThresholdValue: (value) => value === null || Number.isFinite(value) ? null : 'must be a number',
  // eagle-admin sends [latitude, longitude] from two text inputs, so numbers or numeric strings.
  centroid: (value) => value === null || (Array.isArray(value) && value.length <= 2 &&
    value.every(v => Number.isFinite(v) || (typeof v === 'string' && v.length <= 50)))
    ? null : 'must be an array of at most 2 numbers or strings'
});

const FIELDS = [...Object.keys(SCHEMA), ...Object.keys(NUMBER_FIELDS)];

/**
 * What a field missing from a PUT becomes. eagle-api writes '' (projectNotification.js:114-135),
 * which its push turns into these (controllers/nosql/notification.js), so a DEMI row reads the
 * same as a mirrored one.
 */
const DEFAULTS = Object.freeze({
  ...Object.fromEntries(FIELDS.map(key => [key, null])),
  centroid: [],
  pcp: 'none',
  isMet: false,
  metURL: ''
});

/** Create adds `isPublished`, in place of eagle-api's `?publish=` flag (projectNotification.js:84). */
const CREATE_SCHEMA = Object.freeze({ ...SCHEMA, isPublished: { type: 'boolean' } });

/** Visibility moves only through publish and unpublish, so a body's `read` and `isPublished` are dropped. */
const IGNORED_ON_UPDATE = ['read', 'isPublished'];

const readNotification = (ctx, id) => notifications.getById(ctx.access, id);

const actorOf = (ctx) => (ctx.req.user && ctx.req.user.preferred_username) || '';

/** `schema` plus the number fields, every field error in one result. */
function checkBody(schema, input) {
  const checked = check(schema, without(input, Object.keys(NUMBER_FIELDS)));
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return checked;

  const fields = checked.status === 'ok' ? {} : { ...checked.fields };
  const value = checked.status === 'ok' ? { ...checked.value } : {};
  for (const [key, error] of Object.entries(NUMBER_FIELDS)) {
    if (!Object.hasOwn(input, key)) continue;
    const message = error(input[key]);
    if (message) fields[key] = message;
    else value[key] = input[key];
  }
  return Object.keys(fields).length ? { status: 'invalid', fields } : { status: 'ok', value };
}

/** Every field, missing ones defaulted: eagle-api's `value || default`, `??` for isMet (:134). */
function replaced(value) {
  return Object.fromEntries(FIELDS.map(key => [key,
    key === 'isMet' ? value.isMet ?? DEFAULTS.isMet : value[key] || DEFAULTS[key]]));
}

function auditOf(action, fields) {
  return (saved) => ({ action, targetType: 'notification', targetId: saved.id, detail: { fields } });
}

/** The Update parent gate caches every notification's read (`updates.forgetParents`). */
function forgetParentsOn(written) {
  if (written.status === 'ok') updates.forgetParents();
  return written;
}

/**
 * @param {{access: object, req: object}} ctx
 * @param {object} input the request body; `read` is ignored, `isPublished` defaults to false
 */
async function create(ctx, input) {
  const checked = checkBody(CREATE_SCHEMA, without(input, ['read']));
  if (checked.status !== 'ok') return checked;
  const { isPublished = false, ...fields } = checked.value;

  const id = crypto.randomUUID();
  const actor = actorOf(ctx);
  const now = new Date().toISOString();
  // eagle-api's SECURE_ROLES (projectNotification.js:79-81), public only when asked for.
  const read = [...(isPublished ? PUBLIC_READ : STAFF_READ)];
  const row = {
    id,
    eagleId: null,
    sourceSystem: 'demi',
    ...replaced(fields),
    addedBy: actor,
    updatedBy: actor,
    dateAdded: now,
    dateUpdated: now,
    isPublished: read.includes('public'),
    read
  };

  return forgetParentsOn(await writeRow({
    ctx,
    repo: notifications,
    existing: null,
    reread: () => readNotification(ctx, id),
    build: () => row,
    audit: auditOf('notification.create', Object.keys(checked.value))
  }));
}

/**
 * Replaces every field, as eagle-api's PUT does (projectNotification.js:114-135); a field the body
 * leaves out goes back to its default.
 *
 * @param {{access: object, req: object}} ctx
 * @param {string} id
 * @param {object} changes the request body; `read` and `isPublished` are ignored
 */
async function update(ctx, id, changes) {
  const checked = checkBody(SCHEMA, without(changes, IGNORED_ON_UPDATE));
  if (checked.status !== 'ok') return checked;
  const given = Object.keys(checked.value);
  if (given.length === 0) return { status: 'invalid', fields: { body: 'must name at least one field' } };

  const existing = await readNotification(ctx, id);
  if (!existing) return { status: 'not-found' };

  const next = replaced(checked.value);
  const refused = refusedWriteKeys(notifications.CONTAINER, next, ctx.access, existing);
  if (refused.length) {
    return { status: 'invalid', fields: Object.fromEntries(refused.map(key => [key, 'is not writable by this caller'])) };
  }

  const actor = actorOf(ctx);
  return writeRow({
    ctx,
    repo: notifications,
    existing,
    reread: () => readNotification(ctx, id),
    build: (current) => current && { ...current, ...next, updatedBy: actor, dateUpdated: new Date().toISOString() },
    audit: auditOf('notification.update', given)
  });
}

/**
 * eagle-api's `?publish=true|false` on POST and PUT (projectNotification.js:84,137-144), as two
 * actions. No ceiling: `associatedProjectId` is a loose reference, so no project caps the read.
 */
function setPublished(published) {
  const action = published ? 'notification.publish' : 'notification.unpublish';
  return async function (ctx, id) {
    const actor = actorOf(ctx);
    // A missing row reaches `build` as null, which writeRow answers as not-found.
    return forgetParentsOn(await writeRow({
      ctx,
      repo: notifications,
      existing: await readNotification(ctx, id),
      reread: () => readNotification(ctx, id),
      build: (current) => current && {
        ...current,
        isPublished: published,
        read: readWith(current.read, published),
        updatedBy: actor,
        dateUpdated: new Date().toISOString()
      },
      audit: auditOf(action, ['isPublished'])
    }));
  };
}

module.exports = {
  SCHEMA,
  DEFAULTS,
  create,
  update,
  publish: setPublished(true),
  unpublish: setPublished(false)
};
