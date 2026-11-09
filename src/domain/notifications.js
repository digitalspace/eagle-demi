'use strict';

/**
 * Project notification writes (create, PUT, publish, unpublish), ported from eagle-api
 * `api/controllers/projectNotification.js`; rules in docs/eagle-api-port.md.
 */

const crypto = require('node:crypto');

const notifications = require('../repositories/notifications');
const updates = require('../repositories/updates');
const { refusedWriteKeys } = require('../vis/redact');
const { check, without } = require('./_schema');
const { writeRow, queued, readWith, STAFF_READ, PUBLIC_READ } = require('./_write');
const { NOTIFICATION } = require('../sync-out/kinds');
const { logger } = require('../utils/logger');
const { SCHEMA, NUMBER_FIELDS, FIELDS, DEFAULTS } = require('./notification-fields');

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

/** `keys` of `value`, an empty one defaulted: eagle-api's `value || default`, `??` for isMet (:134). */
function defaulted(value, keys = FIELDS) {
  return Object.fromEntries(keys.map(key => [key,
    key === 'isMet' ? value.isMet ?? DEFAULTS.isMet : value[key] || DEFAULTS[key]]));
}

/** A DEMI write owns the row, so the Eagle mirror stops replacing it and sync-out sends it. */
const ownedByDemi = (row) => ({ ...row, sourceSystem: 'demi' });

function auditOf(action, fields) {
  return (saved, from) => {
    // writeRow calls this once, when the write lands, with the row it replaced.
    if (from && from.sourceSystem !== 'demi') {
      logger.info('[Notification] DEMI write took over an Eagle notification', { id: saved.id, eagleId: saved.eagleId });
    }
    return { action, targetType: 'notification', targetId: saved.id, detail: { fields } };
  };
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
    ...defaulted(fields),
    notificationReceivedDate: fields.notificationReceivedDate || now,
    addedBy: actor,
    updatedBy: actor,
    dateAdded: now,
    dateUpdated: now,
    isPublished: read.includes('public'),
    read
  };

  return queued(forgetParentsOn(await writeRow({
    ctx,
    repo: notifications,
    existing: null,
    reread: () => readNotification(ctx, id),
    build: () => row,
    audit: auditOf('notification.create', Object.keys(checked.value))
  })), NOTIFICATION);
}

/**
 * Sets the fields the body names; one sent empty goes to its default, as eagle-api's PUT maps it
 * (projectNotification.js:114-135). A field the body leaves out keeps its stored value.
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

  const next = defaulted(checked.value, given);
  // A null received date is filled in by `build`, which writes the field even when the body left it out.
  const fillsDate = !{ ...existing, ...next }.notificationReceivedDate;
  const refused = refusedWriteKeys(notifications.CONTAINER,
    fillsDate ? { ...next, notificationReceivedDate: null } : next, ctx.access, existing);
  if (refused.length) {
    return { status: 'invalid', fields: Object.fromEntries(refused.map(key => [key, 'is not writable by this caller'])) };
  }

  const actor = actorOf(ctx);
  return queued(await writeRow({
    ctx,
    repo: notifications,
    existing,
    reread: () => readNotification(ctx, id),
    build: (current) => {
      if (!current) return null;
      const now = new Date().toISOString();
      const row = ownedByDemi({ ...current, ...next, updatedBy: actor, dateUpdated: now });
      row.notificationReceivedDate ||= current.dateAdded || notifications.createdAtOf(current.eagleId) || now;
      return row;
    },
    audit: auditOf('notification.update', given)
  }), NOTIFICATION);
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
    return queued(forgetParentsOn(await writeRow({
      ctx,
      repo: notifications,
      existing: await readNotification(ctx, id),
      reread: () => readNotification(ctx, id),
      build: (current) => current && ownedByDemi({
        ...current,
        isPublished: published,
        read: readWith(current.read, published),
        updatedBy: actor,
        dateUpdated: new Date().toISOString()
      }),
      audit: auditOf(action, ['isPublished'])
    })), NOTIFICATION);
  };
}

module.exports = {
  create,
  update,
  publish: setPublished(true),
  unpublish: setPublished(false)
};
