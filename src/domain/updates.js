'use strict';

/**
 * Update writes: `POST /updates`, `PUT /updates/:id` and `DELETE /updates/:id`, ported from
 * eagle-api `api/controllers/recentActivity.js` and `api/helpers/updateRules.js` (rules in
 * docs/eagle-api-port.md, Updates).
 */

const crypto = require('node:crypto');

const updates = require('../repositories/updates');
const documents = require('../repositories/documents');
const { resolveAccess } = require('../helpers/access-sql');
const updateParent = require('../helpers/update-parent');
const { refusedWriteKeys } = require('../vis/redact');
const { check, without } = require('./_schema');
const { writeRow, STAFF_READ, PUBLIC_READ } = require('./_write');
const { logger } = require('../utils/logger');

/** updateRules.js:11. */
const STATUSES = Object.freeze(['draft', 'published', 'archived']);
const PUBLISHED = 'published';
const ARCHIVED = 'archived';
/** updateRules.js:18: the one type that keeps `notificationName`. */
const PN_PCP_TYPE = 'Project Notification Public Comment Period';
const CORPORATE = 'Corporate';

/** updateRules.js:12-16. */
const IMAGES_MAX = 5;
const CAPTION_MAX = 300;
const CREDIT_MAX = 150;
const ALT_MAX = 500;
const REGIONS_MAX = 50;
const REGION_MAX = 200;

const TEXT = (max) => ({ type: 'string', max, nullable: true });
const NULLABLE_ID = { type: 'id', nullable: true };

/** The flat fields a body may set. `featuredImage`, `images` and `regions` are checked by `shapeErrors`. */
const FIELDS = Object.freeze({
  projectId: NULLABLE_ID,
  headline: TEXT(1000),
  content: TEXT(100000),
  type: TEXT(200),
  active: { type: 'boolean' },
  complianceAndEnforcement: { type: 'boolean' },
  notificationName: TEXT(1000),
  contentUrl: TEXT(2000),
  documentUrl: TEXT(2000),
  pcp: NULLABLE_ID,
  projectNotification: NULLABLE_ID,
  category: TEXT(200),
  subject: TEXT(500),
  shortHeadline: TEXT(70),
  summary: TEXT(280),
  attachments: { type: 'idArray', max: 100 },
  location: TEXT(1000),
  engagementUrl: TEXT(2000),
  status: { type: 'enum', values: STATUSES, nullable: true },
  publishDate: { type: 'isoDate', nullable: true }
});
const CREATE_SCHEMA = FIELDS;
/** PUT may also pin; a create always starts unpinned (recentActivity.js:183). */
const UPDATE_SCHEMA = Object.freeze({ ...FIELDS, pinned: { type: 'boolean' }, _etag: { type: 'string', max: 200 } });

const SHAPED = ['featuredImage', 'images', 'regions'];
/** eagle-api drops these from every body (recentActivity.js:151-157,218-219); the dates are stamped here. */
const IGNORED = ['_id', 'notifiedAt', 'read', 'dateAdded', 'dateUpdated'];
const IGNORED_ON_CREATE = [...IGNORED, 'pinned'];

const STALE_EDIT = 'The update was changed by someone else. Reload and try again.';
const NOT_PUBLIC = 'featuredImage, images and attachments must be public documents';

const isBlank = (value) => value === undefined || value === null || String(value).trim() === '';
// Browsers open a tag at `<` plus a letter, `/` or `!` (updateRules.js:28).
const hasTag = (value) => /<[a-z/!]/i.test(String(value));

function isHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const IMAGE_SCHEMA = Object.freeze({
  document: NULLABLE_ID, alt: TEXT(ALT_MAX), caption: TEXT(CAPTION_MAX), credit: TEXT(CREDIT_MAX)
});

/** One image's errors under `label`; `requireDocument` for a gallery entry, which shows nothing without one. */
function imageErrors(image, label, { requireDocument }) {
  const checked = check(IMAGE_SCHEMA, image);
  const errors = Object.fromEntries(Object.entries(checked.status === 'ok' ? {} : checked.fields)
    .map(([key, message]) => [key === 'body' ? label : `${label}.${key}`, message]));
  if (!isObject(image)) return errors;
  if (isBlank(image.document) && requireDocument) errors[`${label}.document`] = 'is required';
  if (!isBlank(image.document) && isBlank(image.alt)) errors[`${label}.alt`] = 'is required with a document';
  // Rendered on a public page, so markup is refused rather than stripped the way the mirror does.
  for (const key of ['alt', 'caption', 'credit']) {
    if (typeof image[key] === 'string' && hasTag(image[key])) errors[`${label}.${key}`] = 'must be plain text, no HTML tags';
  }
  return errors;
}

/** The nested fields `check` has no type for. */
function shapeErrors(body) {
  let errors = {};
  if (Object.hasOwn(body, 'featuredImage') && body.featuredImage !== null) {
    errors = { ...errors, ...imageErrors(body.featuredImage, 'featuredImage', { requireDocument: false }) };
  }
  if (Object.hasOwn(body, 'images')) {
    if (!Array.isArray(body.images)) errors.images = 'must be a list';
    else if (body.images.length > IMAGES_MAX) errors.images = `must hold ${IMAGES_MAX} or fewer`;
    else body.images.forEach((image, i) => { errors = { ...errors, ...imageErrors(image, `images[${i}]`, { requireDocument: true }) }; });
  }
  if (Object.hasOwn(body, 'regions')) {
    const ok = Array.isArray(body.regions) && body.regions.length <= REGIONS_MAX &&
      body.regions.every(region => typeof region === 'string' && region.length <= REGION_MAX);
    if (!ok) errors.regions = `must be a list of at most ${REGIONS_MAX} strings`;
  }
  return errors;
}

/** The stored form of the nested fields a body gave. */
function shaped(body) {
  const imageOf = (image) => ({
    document: isBlank(image.document) ? null : String(image.document),
    alt: image.alt ?? null,
    caption: isBlank(image.caption) ? null : image.caption,
    credit: isBlank(image.credit) ? null : image.credit
  });
  const out = {};
  if (Object.hasOwn(body, 'featuredImage')) {
    out.featuredImage = body.featuredImage && !isBlank(body.featuredImage.document) ? imageOf(body.featuredImage) : null;
  }
  if (Object.hasOwn(body, 'images')) out.images = body.images.map(imageOf);
  if (Object.hasOwn(body, 'regions')) out.regions = body.regions.map(region => region.trim());
  return out;
}

/** `schema` plus the nested fields, every error in one result. */
function checkBody(schema, body, options) {
  if (!isObject(body)) return { status: 'invalid', fields: { body: 'must be a JSON object' } };
  const flat = check(schema, without(body, SHAPED), options);
  const nested = shapeErrors(body);
  const fields = { ...(flat.status === 'ok' ? {} : flat.fields), ...nested };
  if (Object.keys(fields).length) return { status: 'invalid', fields };
  return { status: 'ok', value: { ...flat.value, ...shaped(body) } };
}

/** updateRules.validate (:77-110): the rules over the row as it will be stored. */
function rowErrors(row) {
  const errors = {};
  for (const field of ['shortHeadline', 'summary']) {
    if (!isBlank(row[field]) && hasTag(row[field])) errors[field] = 'must be plain text, no HTML tags';
  }
  if (!isBlank(row.engagementUrl) && !isHttpUrl(row.engagementUrl)) errors.engagementUrl = 'must be an http or https URL';
  // Rows written before categories carry none and keep saving; comment period Updates hang off a pcp or a notification.
  if (!isBlank(row.category)) {
    if (row.category === CORPORATE && isBlank(row.subject)) {
      errors.subject = 'is required for a Corporate update';
    } else if (row.category !== CORPORATE && isBlank(row.projectId) && isBlank(row.pcp) && row.type !== PN_PCP_TYPE) {
      errors.projectId = 'is required unless the category is Corporate';
    }
  }
  return errors;
}

/** updateRules.isLive (:155-158): eagle-api's own test, where a status-less row goes by `active`. */
function wasLive(row, now) {
  const published = row.status === PUBLISHED || (isBlank(row.status) && row.active === true);
  return published && (isBlank(row.publishDate) || Date.parse(row.publishDate) <= Date.parse(now));
}

/**
 * updateRules.applyStatus (:117-131): `status`, `active` and `publishDate` agree, and the update's
 * own read follows the status alone. Only `published` opens it; anything else is staff only.
 *
 * @param {object} given the body as checked
 * @param {object} merged the stored row with `given` laid over it
 */
function statusFields(given, merged, { live, now }) {
  const status = isBlank(merged.status) ? (merged.active === true ? PUBLISHED : 'draft') : merged.status;
  const published = status === PUBLISHED;
  // Going live with no date given means now; a row already live keeps the date it went live.
  const stamp = published && (isBlank(merged.publishDate) || (isBlank(given.publishDate) && !live));
  return {
    status,
    active: published,
    // Never absent: the publish gate and every sort read `publishDate` alone (repositories/updates.js).
    publishDate: stamp ? now : (merged.publishDate || merged.dateAdded || now),
    own: [...(published ? PUBLIC_READ : STAFF_READ)]
  };
}

/** The row's read under its parent, and the copy of the inputs a DEMI row keeps for itself. */
function readFields(current, own, status, parent) {
  const read = updateParent.readUnder(own, parent);
  return {
    read,
    isPublished: read.includes('public'),
    ...(current.sourceSystem === 'demi' && { sources: { ...current.sources, demi: { read: own, status } } })
  };
}

const idsShown = (row) => [...new Set([
  row.featuredImage && row.featuredImage.document,
  ...(row.images || []).map(image => image && image.document),
  ...(row.attachments || [])
].filter(id => !isBlank(id)).map(String))];

/** updateRules.isPinToggle: a published update that only flips `pinned` skips the document check (:251). */
const isPinToggle = (existing, updated) => existing.status === PUBLISHED && updated.status === PUBLISHED &&
  Boolean(existing.pinned) !== Boolean(updated.pinned) &&
  idsShown(existing).sort().join() === idsShown(updated).sort().join();

/** The shown documents an anonymous caller cannot read (updateRules.nonPublicDocumentIds). */
async function nonPublicIds(row) {
  const ids = idsShown(row);
  if (!ids.length) return [];
  const visible = new Set();
  // listByIdsUnscoped takes at most 200 ids per call; a row shows at most 106.
  for (const doc of await documents.listByIdsUnscoped(resolveAccess({}), ids, 'c.id')) visible.add(String(doc.id));
  return ids.filter(id => !visible.has(id));
}

/** The parent of `projectId`, `null` for none, `undefined` when DEMI holds no such project or notification. */
async function parentOf(projectId) {
  if (isBlank(projectId)) return null;
  return (await updateParent.readParent(String(projectId))) || undefined;
}

const actorOf = (ctx) => (ctx.req.user && ctx.req.user.preferred_username) || '';

function auditOf(action, fields) {
  return (saved) => ({
    action, targetType: 'update', targetId: saved.id, projectId: saved.projectId, ...(fields && { detail: { fields } })
  });
}

/** Thrown from a build when the row moved past the version the client loaded. */
const STALE = Symbol('stale edit');

/** The row checked, its documents public when it will be published; null when it passes. */
async function refusal(row, { checkDocuments = true } = {}) {
  const errors = rowErrors(row);
  if (Object.keys(errors).length) return { status: 'invalid', fields: errors };
  if (checkDocuments && row.status === PUBLISHED) {
    const hidden = await nonPublicIds(row);
    if (hidden.length) {
      logger.info('[Update] publish refused, documents not public', { id: row.id, count: hidden.length });
      return { status: 'invalid', fields: { documents: `${NOT_PUBLIC}; not public: ${hidden.join(', ')}` } };
    }
  }
  return null;
}

/**
 * @param {{access: object, req: object}} ctx
 * @param {object} input the request body
 */
async function create(ctx, input) {
  const checked = checkBody(CREATE_SCHEMA, without(input, IGNORED_ON_CREATE));
  if (checked.status !== 'ok') return checked;
  const given = checked.value;

  const parent = await parentOf(given.projectId);
  if (parent === undefined) return { status: 'invalid', fields: { projectId: 'must name a project or notification' } };

  const id = crypto.randomUUID();
  const actor = actorOf(ctx);
  const now = new Date().toISOString();
  const base = {
    id,
    eagleId: null,
    sourceSystem: 'demi',
    projectId: null,
    headline: null,
    content: null,
    type: null,
    complianceAndEnforcement: false,
    contentUrl: null,
    documentUrl: null,
    pcp: null,
    projectNotification: null,
    category: null,
    subject: null,
    shortHeadline: null,
    summary: null,
    featuredImage: null,
    images: [],
    attachments: [],
    regions: [],
    location: null,
    engagementUrl: null,
    ...given,
    pinned: false,
    dateAdded: now,
    dateUpdated: now
  };
  const { own, ...status } = statusFields(given, base, { live: false, now });
  const row = {
    ...base,
    ...status,
    // recentActivity.js:188-190.
    notificationName: base.type === PN_PCP_TYPE ? (given.notificationName ?? null) : null,
    addedBy: actor,
    updatedBy: actor,
    // The announce claim starts empty; the timer announces a published row once it is due.
    notifiedAt: null,
    notifiedBy: null,
    ...Object.fromEntries(updates.NOTIFY_STATE_FIELDS.map(field => [field, null])),
    notifyAttempts: 0,
    ...readFields({ sourceSystem: 'demi' }, own, status.status, parent)
  };
  const refused = await refusal(row);
  if (refused) return refused;

  return writeRow({
    ctx,
    repo: updates,
    existing: null,
    reread: () => updates.getById(ctx.access, id),
    build: () => row,
    audit: auditOf('update.create', Object.keys(given))
  });
}

/**
 * eagle-api `protectedPut` (recentActivity.js:212-298) over a partial body. `_etag`, when given,
 * is the version the client loaded: a row that moved past it is a 409.
 *
 * @param {{access: object, req: object}} ctx
 * @param {string} id
 * @param {object} changes any subset of UPDATE_SCHEMA plus the nested fields
 */
async function update(ctx, id, changes) {
  const checked = checkBody(UPDATE_SCHEMA, without(changes, IGNORED), { partial: true });
  if (checked.status !== 'ok') return checked;
  const { _etag: loaded, ...given } = checked.value;
  const fields = Object.keys(given);
  if (fields.length === 0) return { status: 'invalid', fields: { body: 'must name at least one field' } };
  // A null date keeps the stored one (recentActivity.js:244-246).
  if (given.publishDate === null) delete given.publishDate;

  const existing = await updates.getById(ctx.access, id);
  if (!existing) return { status: 'not-found' };
  const refused = refusedWriteKeys(updates.CONTAINER, given, ctx.access, existing);
  if (refused.length) {
    return { status: 'invalid', fields: Object.fromEntries(refused.map(key => [key, 'is not writable by this caller'])) };
  }

  const movesParent = Object.hasOwn(given, 'projectId');
  // A stored parent DEMI does not hold caps nothing, as on the mirror; only moving to one is refused.
  const parent = await parentOf(movesParent ? given.projectId : existing.projectId);
  if (parent === undefined && movesParent) {
    return { status: 'invalid', fields: { projectId: 'must name a project or notification' } };
  }

  const actor = actorOf(ctx);
  const rowFor = (current) => {
    const now = new Date().toISOString();
    // A body that names neither keeps the status; `active` alone derives one, except on an archived row.
    const derive = given.status === undefined && given.active !== undefined && current.status !== ARCHIVED;
    const merged = { ...current, ...(derive && { status: null }), ...given };
    const { own, ...status } = statusFields(given, merged, { live: wasLive(current, now), now });
    return {
      ...merged,
      ...status,
      notificationName: merged.type === PN_PCP_TYPE ? merged.notificationName ?? null : null,
      ...readFields(current, own, status.status, parent),
      updatedBy: actor,
      dateUpdated: now
    };
  };

  const preview = rowFor(existing);
  const invalid = await refusal(preview, { checkDocuments: !isPinToggle(existing, preview) });
  if (invalid) return invalid;

  try {
    return await writeRow({
      ctx,
      repo: updates,
      existing,
      reread: () => updates.getById(ctx.access, id),
      build: (current) => {
        if (!current) return null;
        if (loaded !== undefined && current._etag !== loaded) throw STALE;
        return rowFor(current);
      },
      audit: auditOf('update.update', fields)
    });
  } catch (err) {
    if (err !== STALE) throw err;
    logger.warn('[Update] edit refused, row changed since the client read it', { id });
    return { status: 'conflict', error: STALE_EDIT };
  }
}

/**
 * eagle-api `protectedDelete` (recentActivity.js:111-142): archive, never delete, so a published
 * update's URL keeps answering. `public` leaves the read.
 */
async function remove(ctx, id) {
  const existing = await updates.getById(ctx.access, id);
  if (!existing) return { status: 'not-found' };

  const actor = actorOf(ctx);
  return writeRow({
    ctx,
    repo: updates,
    existing,
    reread: () => updates.getById(ctx.access, id),
    build: (current) => {
      if (!current) return null;
      const read = (current.read || []).filter(role => role !== 'public');
      return {
        ...current,
        status: ARCHIVED,
        active: false,
        read,
        isPublished: false,
        ...(current.sourceSystem === 'demi' && {
          sources: { ...current.sources, demi: { read: [...STAFF_READ], status: ARCHIVED } }
        }),
        updatedBy: actor,
        dateUpdated: new Date().toISOString()
      };
    },
    audit: auditOf('update.archive')
  });
}

module.exports = { STATUSES, CREATE_SCHEMA, UPDATE_SCHEMA, create, update, remove };
