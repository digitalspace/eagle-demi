'use strict';

/**
 * Comment writes: `POST /comments`, `PUT /comments/:id` and `PUT /comments/:id/status`, ported
 * from eagle-api `api/controllers/comment.js` (rules in docs/eagle-api-port.md, Comments).
 */

const crypto = require('node:crypto');

const comments = require('../repositories/comments');
const commentPeriods = require('../repositories/comment-periods');
const { systemAccess } = require('../helpers/access-sql');
const { eagleReadUnder } = require('../helpers/eagle-acl');
const { refusedWriteKeys } = require('../vis/redact');
const { check, without } = require('./_schema');
const { writeRow, STAFF_READ, PUBLIC_READ } = require('./_write');
const { logger } = require('../utils/logger');

/** eagle-api's `setPermissionsFromEaoStatus` (comment.js:32-64): `Reset` is stored as `Pending`. */
const STATUSES = Object.freeze(['Pending', 'Published', 'Deferred', 'Rejected', 'Reset']);
const STATUS = { type: 'enum', values: STATUSES };

const TEXT = { type: 'string', max: 10000, nullable: true };
const SHORT = { type: 'string', max: 500, nullable: true };

/** The fields eagle-api's PUT copies from the body (comment.js:395-406); `dateUpdated` is stamped. */
const UPDATE_SCHEMA = Object.freeze({
  isAnonymous: { type: 'boolean' },
  datePosted: { type: 'isoDate', nullable: true },
  eaoNotes: TEXT,
  eaoStatus: STATUS,
  submittedCAC: { type: 'boolean' },
  proponentNotes: TEXT,
  proponentStatus: SHORT,
  publishedNotes: TEXT,
  rejectedNotes: TEXT,
  rejectedReason: TEXT
});

/** The fields eagle-api's POST copies from the body (comment.js:344-360), `period` as `periodId`. */
const CREATE_SCHEMA = Object.freeze({
  periodId: { type: 'string', max: 200, required: true },
  author: SHORT,
  comment: { type: 'string', max: 50000, nullable: true },
  dateAdded: { type: 'isoDate' },
  datePosted: { type: 'isoDate', nullable: true },
  documents: { type: 'idArray', max: 100 },
  eaoNotes: TEXT,
  eaoStatus: STATUS,
  isAnonymous: { type: 'boolean' },
  location: { type: 'string', max: 1000, nullable: true },
  proponentNotes: TEXT,
  proponentStatus: SHORT,
  publishedNotes: TEXT,
  rejectedNotes: TEXT,
  rejectedReason: TEXT,
  valuedComponents: { type: 'idArray', max: 100 }
});

const STATUS_SCHEMA = Object.freeze({ status: { ...STATUS, required: true } });

/** Stamped by the server, so a body that echoes it back is not refused. */
const STAMPED = ['dateUpdated'];

const NO_PERIOD = 'The comment has no comment period.';

const actorOf = (ctx) => (ctx.req.user && ctx.req.user.preferred_username) || '';

function auditOf(action, fields) {
  return (saved) => ({
    action, targetType: 'comment', targetId: saved.id, projectId: saved.projectId, ...(fields && { detail: { fields } })
  });
}

/**
 * The stored status and the comment's own read for `status`. Only `Published` opens a comment;
 * an absent status reads staff-only, never Eagle's `project-system-admin` default.
 */
function moderation(status) {
  const eaoStatus = status === 'Reset' ? 'Pending' : (status ?? null);
  return { eaoStatus, own: [...(eaoStatus === 'Published' ? PUBLIC_READ : STAFF_READ)] };
}

/** The status fields of a row whose comment sits under `period`; a DEMI row records its own read for the period cascade. */
function statusFields(current, status, period) {
  const { eaoStatus, own } = moderation(status);
  const read = eagleReadUnder(own, period.read);
  return {
    eaoStatus,
    read,
    isPublished: read.includes('public'),
    ...(current.sourceSystem === 'demi' && { sources: { ...current.sources, demi: { read: own } } })
  };
}

const readComment = (ctx, id) => comments.getById(ctx.access, id);
const periodOf = (comment) => commentPeriods.getById(systemAccess(), comment.periodId, comment.projectId);

/**
 * @param {{access: object, req: object}} ctx
 * @param {object} input the request body
 */
async function create(ctx, input) {
  const checked = check(CREATE_SCHEMA, without(input, STAMPED));
  if (checked.status !== 'ok') return checked;
  const { periodId, eaoStatus: status, datePosted = null, ...fields } = checked.value;

  const period = await commentPeriods.getById(ctx.access, periodId);
  if (!period) return { status: 'invalid', fields: { periodId: 'must name a comment period' } };
  const commentId = await commentPeriods.nextCommentId(period.id, period.projectId);
  if (commentId === null) return { status: 'invalid', fields: { periodId: 'must name a comment period' } };

  const id = crypto.randomUUID();
  const actor = actorOf(ctx);
  const now = new Date().toISOString();
  const row = {
    id,
    eagleId: null,
    periodId: String(period.id),
    projectId: String(period.projectId),
    sourceSystem: 'demi',
    author: null,
    comment: null,
    dateAdded: now,
    documents: [],
    eaoNotes: null,
    isAnonymous: true,
    location: null,
    proponentNotes: null,
    proponentStatus: null,
    publishedNotes: null,
    rejectedNotes: null,
    rejectedReason: null,
    submittedCAC: false,
    valuedComponents: [],
    ...fields,
    commentId,
    addedBy: actor,
    updatedBy: actor,
    dateUpdated: now,
    // eagle-api keeps a posted date only on a published comment (comment.js:361).
    datePosted: status === 'Published' ? datePosted : null,
    ...statusFields({ sourceSystem: 'demi' }, status, period)
  };
  logger.info('[Comment] numbered a new comment', { periodId: row.periodId, commentId });

  return writeRow({
    ctx,
    repo: comments,
    existing: null,
    reread: () => comments.getById(ctx.access, id, row.periodId),
    build: () => row,
    audit: auditOf('comment.create', Object.keys(checked.value))
  });
}

/**
 * @param {{access: object, req: object}} ctx
 * @param {string} id
 * @param {object} changes any subset of UPDATE_SCHEMA; `eaoStatus` moves the read as the status route does
 */
async function update(ctx, id, changes) {
  const checked = check(UPDATE_SCHEMA, without(changes, STAMPED), { partial: true });
  if (checked.status !== 'ok') return checked;
  const fields = Object.keys(checked.value);
  if (fields.length === 0) return { status: 'invalid', fields: { body: 'must name at least one field' } };

  const existing = await readComment(ctx, id);
  if (!existing) return { status: 'not-found' };

  const refused = refusedWriteKeys(comments.CONTAINER, checked.value, ctx.access, existing);
  if (refused.length) {
    return { status: 'invalid', fields: Object.fromEntries(refused.map(key => [key, 'is not writable by this caller'])) };
  }

  const { eaoStatus: status, ...rest } = checked.value;
  const period = status === undefined ? null : await periodOf(existing);
  if (status !== undefined && !period) return { status: 'conflict', error: NO_PERIOD };

  const actor = actorOf(ctx);
  return writeRow({
    ctx,
    repo: comments,
    existing,
    reread: () => readComment(ctx, id),
    build: (current) => current && {
      ...current,
      ...rest,
      ...(period && statusFields(current, status, period)),
      updatedBy: actor,
      dateUpdated: new Date().toISOString()
    },
    audit: auditOf('comment.update', fields)
  });
}

/**
 * eagle-api `protectedStatus` (comment.js:426-447): the status and read, stamped. The body is
 * `{ status }`, where eagle-api's is `{ status: { status } }`.
 */
async function setStatus(ctx, id, input) {
  const checked = check(STATUS_SCHEMA, input);
  if (checked.status !== 'ok') return checked;

  const existing = await readComment(ctx, id);
  if (!existing) return { status: 'not-found' };
  const period = await periodOf(existing);
  if (!period) return { status: 'conflict', error: NO_PERIOD };

  const actor = actorOf(ctx);
  return writeRow({
    ctx,
    repo: comments,
    existing,
    reread: () => readComment(ctx, id),
    build: (current) => current && {
      ...current,
      ...statusFields(current, checked.value.status, period),
      updatedBy: actor,
      dateUpdated: new Date().toISOString()
    },
    audit: auditOf('comment.setStatus', ['eaoStatus'])
  });
}

module.exports = { STATUSES, CREATE_SCHEMA, UPDATE_SCHEMA, create, update, setStatus };
