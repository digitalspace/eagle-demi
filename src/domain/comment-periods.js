'use strict';

/**
 * Comment period writes: `POST /comment-periods`, `PUT`, `DELETE`, publish and unpublish on
 * `/comment-periods/:id`, ported from eagle-api `api/controllers/commentperiod.js` (rules in
 * docs/eagle-api-port.md, Comment periods).
 */

const crypto = require('node:crypto');

const commentPeriods = require('../repositories/comment-periods');
const comments = require('../repositories/comments');
const projects = require('../repositories/projects');
const notifications = require('../repositories/notifications');
const { DELETED_CEILING } = require('../repositories/documents');
const { systemAccess } = require('../helpers/access-sql');
const { eagleBaseAcl, eagleReadUnder } = require('../helpers/eagle-acl');
const { refusedWriteKeys } = require('../vis/redact');
const { check } = require('./_schema');
const { writeRow } = require('./_write');
const { logger } = require('../utils/logger');

const URL_FIELD = { type: 'string', max: 2000 };
const TEXT = { type: 'string', max: 10000 };
const DATE = { type: 'isoDate', nullable: true };

/** The fields eagle-api's PUT copies from the body (commentperiod.js:326-341), visibility aside. */
const UPDATE_SCHEMA = Object.freeze({
  commentTip: TEXT,
  dateCompleted: DATE,
  dateStarted: DATE,
  isMet: { type: 'boolean' },
  instructions: TEXT,
  informationLabel: TEXT,
  metURL: URL_FIELD,
  metBannerImageUrl: URL_FIELD,
  milestone: { type: 'id', nullable: true }
});

/** eagle-api's POST adds `metURLAdmin`, `project` and `isPublished` (commentperiod.js:270-293). */
const CREATE_SCHEMA = Object.freeze({
  ...UPDATE_SCHEMA,
  metURLAdmin: URL_FIELD,
  projectId: { type: 'string', max: 200, required: true },
  isPublished: { type: 'boolean' }
});

/** Lists `_schema` has no type for, checked here: eagle-api stores them as given. */
const LISTS = Object.freeze({
  openHouses: { max: 50, ok: (item) => item !== null && typeof item === 'object' && !Array.isArray(item)
    && Object.values(item).every(v => v === null || (typeof v === 'string' && v.length <= 10000)) },
  relatedDocuments: { max: 100, ok: (item) => typeof item === 'string' && item.length <= 2000 }
});

/** Visibility moves only through publish and unpublish, so a body's `read` and `isPublished` are dropped. */
const IGNORED_ON_UPDATE = ['read', 'isPublished'];

const STAFF_READ = Object.freeze(['staff', 'sysadmin']);
const PUBLIC_READ = Object.freeze(['public', ...STAFF_READ]);

const ENGAGE_OWNED = 'This comment period is run in ENGAGE. Change it there.';
const ABOVE_PROJECT = 'Cannot publish a comment period above the level of its project.';

const actorOf = (ctx) => (ctx.req.user && ctx.req.user.preferred_username) || '';
const readPeriod = (ctx, id) => commentPeriods.getById(ctx.access, id);

function auditOf(action, fields) {
  return (saved) => ({
    action, targetType: 'commentPeriod', targetId: saved.id, projectId: saved.projectId, ...(fields && { detail: { fields } })
  });
}

const without = (input, keys) => (input && typeof input === 'object' && !Array.isArray(input)
  ? Object.fromEntries(Object.entries(input).filter(([key]) => !keys.includes(key)))
  : input);

/** `check` plus the two lists, every field error in one result. */
function checkBody(schema, input, options) {
  const listKeys = Object.keys(LISTS);
  const checked = check(schema, without(input, listKeys), options);
  if (checked.status !== 'ok' && checked.fields.body) return checked;

  const fields = checked.status === 'ok' ? {} : { ...checked.fields };
  const value = checked.status === 'ok' ? { ...checked.value } : {};
  for (const key of listKeys.filter(k => Object.hasOwn(input, k))) {
    const { max, ok } = LISTS[key];
    const given = input[key];
    if (Array.isArray(given) && given.length <= max && given.every(ok)) value[key] = given;
    else fields[key] = `must be an array of at most ${max} entries`;
  }
  return Object.keys(fields).length ? { status: 'invalid', fields } : { status: 'ok', value };
}

/**
 * The ceiling a period's read sits under: its project's read, or none for a period that hangs off
 * a `ProjectNotification` (see helpers/parent-admit). `undefined` when DEMI holds neither parent.
 */
async function parentCap(projectId) {
  const project = await projects.getById(systemAccess(), projectId);
  if (project) return project.read;
  return await notifications.getById(systemAccess(), projectId) ? null : undefined;
}

const readUnder = (own, cap) => (cap === null ? eagleBaseAcl(own) : eagleReadUnder(own, cap));

/**
 * Re-derive the period's comments from its new read: a comment follows its period only because
 * this writes it down (controllers/nosql/comment-period.js). Runs on every visibility write, so a
 * staff retry after a failed cascade repairs it.
 */
async function cascadeToComments(period, read) {
  const cascade = await comments.setAclForPeriod(systemAccess(), period.id, read);
  if (cascade.failed > 0) {
    logger.error('[CommentPeriod] comment ACL cascade partially failed',
      { periodId: period.id, comments: cascade.succeeded, commentsFailed: cascade.failed });
    throw new Error('comment period written, but its comments were not fully updated');
  }
  logger.info('[CommentPeriod] comment ACL cascade', { periodId: period.id, comments: cascade.succeeded });
}

/** A loaded period this caller may write, or the refusal. */
async function loadWritable(ctx, id) {
  const existing = await readPeriod(ctx, id);
  if (!existing) return { refusal: { status: 'not-found' } };
  if (existing.sourceSystem === 'engage') {
    logger.warn('[CommentPeriod] staff write refused on an ENGAGE period', { id });
    return { refusal: { status: 'conflict', error: ENGAGE_OWNED } };
  }
  return { existing };
}

/**
 * @param {{access: object, req: object}} ctx
 * @param {object} input the request body
 */
async function create(ctx, input) {
  const checked = checkBody(CREATE_SCHEMA, without(input, ['read']));
  if (checked.status !== 'ok') return checked;
  const { projectId, isPublished = false, ...fields } = checked.value;

  const cap = await parentCap(projectId);
  if (cap === undefined) return { status: 'invalid', fields: { projectId: 'must name a project' } };
  const own = eagleBaseAcl(isPublished ? PUBLIC_READ : STAFF_READ);
  const read = readUnder(own, cap);
  if (isPublished && !read.includes('public')) return { status: 'conflict', error: ABOVE_PROJECT };

  const id = crypto.randomUUID();
  const actor = actorOf(ctx);
  const now = new Date().toISOString();
  const row = {
    id,
    eagleId: null,
    projectId: String(projectId),
    sourceSystem: 'demi',
    isMet: false,
    metURL: '',
    metURLAdmin: '',
    metBannerImageUrl: '',
    dateStarted: null,
    dateCompleted: null,
    instructions: '',
    informationLabel: '',
    commentTip: '',
    milestone: null,
    openHouses: [],
    relatedDocuments: [],
    ...fields,
    commentIdCount: 0,
    addedBy: actor,
    updatedBy: actor,
    dateAdded: now,
    dateUpdated: now,
    isDeleted: false,
    isPublished: read.includes('public'),
    read,
    sources: { demi: { read: own } }
  };

  return writeRow({
    ctx,
    repo: commentPeriods,
    existing: null,
    reread: () => commentPeriods.getById(ctx.access, id, projectId),
    build: () => row,
    audit: auditOf('commentPeriod.create', Object.keys(checked.value))
  });
}

/**
 * @param {{access: object, req: object}} ctx
 * @param {string} id
 * @param {object} changes any subset of UPDATE_SCHEMA; `read` and `isPublished` are ignored
 */
async function update(ctx, id, changes) {
  const checked = checkBody(UPDATE_SCHEMA, without(changes, IGNORED_ON_UPDATE), { partial: true });
  if (checked.status !== 'ok') return checked;
  const fields = Object.keys(checked.value);
  if (fields.length === 0) return { status: 'invalid', fields: { body: 'must name at least one field' } };

  const { existing, refusal } = await loadWritable(ctx, id);
  if (refusal) return refusal;

  const refused = refusedWriteKeys(commentPeriods.CONTAINER, checked.value, ctx.access, existing);
  if (refused.length) {
    return { status: 'invalid', fields: Object.fromEntries(refused.map(key => [key, 'is not writable by this caller'])) };
  }

  const actor = actorOf(ctx);
  return writeRow({
    ctx,
    repo: commentPeriods,
    existing,
    reread: () => readPeriod(ctx, id),
    build: (current) => current && {
      ...current, ...checked.value, updatedBy: actor, dateUpdated: new Date().toISOString()
    },
    audit: auditOf('commentPeriod.update', fields)
  });
}

/** Hard delete, as eagle-api's `findOneAndDelete` (commentperiod.js:376); its comments drop to staff first. */
async function remove(ctx, id) {
  const { existing, refusal } = await loadWritable(ctx, id);
  if (refusal) return refusal;

  // Comments before the period: a failure here leaves the period in place for the retry.
  await cascadeToComments(existing, DELETED_CEILING);
  return writeRow({
    ctx,
    repo: {
      upsert: async (row) => {
        await commentPeriods.deleteById(row.id, row.projectId, row._etag);
        return row;
      }
    },
    existing,
    reread: () => readPeriod(ctx, id),
    build: (current) => current,
    audit: auditOf('commentPeriod.delete')
  });
}

/** eagle-api `Actions.publish` and `unPublish` (actions.js:7,31): the period's own `read` and flag only. */
function setPublished(published) {
  const action = published ? 'commentPeriod.publish' : 'commentPeriod.unpublish';
  return async function (ctx, id) {
    const { existing, refusal } = await loadWritable(ctx, id);
    if (refusal) return refusal;

    const cap = await parentCap(existing.projectId);
    if (cap === undefined) return { status: 'conflict', error: 'The comment period has no project.' };
    const own = eagleBaseAcl(published ? PUBLIC_READ : STAFF_READ);
    const read = readUnder(own, cap);
    if (published && !read.includes('public')) return { status: 'conflict', error: ABOVE_PROJECT };

    const actor = actorOf(ctx);
    const written = await writeRow({
      ctx,
      repo: commentPeriods,
      existing,
      reread: () => readPeriod(ctx, id),
      build: (current) => current && {
        ...current,
        isPublished: published,
        read,
        ...(current.sourceSystem === 'demi' && { sources: { ...current.sources, demi: { read: own } } }),
        updatedBy: actor,
        dateUpdated: new Date().toISOString()
      },
      audit: auditOf(action, ['isPublished'])
    });
    if (written.status === 'ok') await cascadeToComments(written.value, read);
    return written;
  };
}

module.exports = {
  CREATE_SCHEMA,
  UPDATE_SCHEMA,
  create,
  update,
  remove,
  publish: setPublished(true),
  unpublish: setPublished(false)
};
