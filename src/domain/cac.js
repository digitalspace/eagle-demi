'use strict';

/**
 * A project's Community Advisory Committee: `GET`, `POST` and `DELETE /projects/:id/cac`,
 * `PUT /projects/:id/cac/publish` and `/unpublish`, `POST /projects/:id/cac/members/remove`.
 * Ported from eagle-api `api/controllers/cac.js` at `b072e79^`; rules in docs/eagle-api-port.md, CAC.
 *
 * The CAC is three project fields. Members live only in eagle-notify, as subscriptions to
 * `cac:<Eagle project id>`, so member removal and CAC delete end them there first and a failed
 * call fails the write.
 */

const projects = require('../repositories/projects');
const notify = require('../services/notify');
const { refusedWriteKeys } = require('../vis/redact');
const { check } = require('./_schema');
const { writeRow } = require('./_write');
const { auditEvent } = require('../utils/audit');
const { logger } = require('../utils/logger');

const FIELDS = Object.freeze(['projectCAC', 'projectCACPublished', 'cacEmail']);
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const EMAIL_SCHEMA = { type: 'string', max: 254, required: true };
const CREATE_SCHEMA = Object.freeze({ cacEmail: EMAIL_SCHEMA });
const REMOVE_MEMBER_SCHEMA = Object.freeze({ address: EMAIL_SCHEMA });

/** The response body: the project id and the CAC fields, redacted as a project by the controller. */
function viewOf(row) {
  const view = { id: row.id, read: row.read, isPublished: row.isPublished };
  if (row.vis) view.vis = row.vis;
  for (const field of FIELDS) view[field] = row[field] === undefined ? null : row[field];
  return view;
}

const readProject = (ctx, id) => projects.getById(ctx.access, id);

const PROJECT_REPO = Object.freeze({
  upsert: (row, current) => projects.upsert(row, { etag: current && current._etag })
});

function checkEmail(schema, input) {
  const checked = check(schema, input);
  if (checked.status !== 'ok') return checked;
  const [key] = Object.keys(schema);
  const value = checked.value[key].trim();
  if (!EMAIL.test(value)) return { status: 'invalid', fields: { [key]: 'must be an email address' } };
  return { status: 'ok', value: { [key]: value } };
}

/** A CAC field a per-project dial hides from this caller is not theirs to write either. */
function refusal(ctx, project) {
  const refused = refusedWriteKeys(projects.CONTAINER, Object.fromEntries(FIELDS.map(key => [key, true])),
    ctx.access, project);
  if (!refused.length) return null;
  logger.warn('[CAC] write refused: field hidden from caller', { projectId: project.id, fields: refused });
  return { status: 'invalid', fields: Object.fromEntries(refused.map(key => [key, 'is not writable by this caller'])) };
}

/** The write's result for a NotifyError, logged; any other error is not ours to map. */
function notifyFailure(err, projectId, call) {
  if (!(err instanceof notify.NotifyError)) throw err;
  if (!err.configured) {
    logger.error('[CAC] notify not configured', { projectId, call });
    return { status: 'unavailable', error: 'The subscription service is not configured. Nothing was changed.' };
  }
  logger.error('[CAC] eagle-notify call failed', { projectId, call, status: err.status, code: err.code, error: err.message });
  return { status: 'upstream-failed', error: 'The subscription service did not remove the members. Nothing was changed.' };
}

/** Sets `changes` on the project and answers the CAC view. */
async function writeFields(ctx, project, changes, action, { created = false, detail = {} } = {}) {
  const result = await writeRow({
    ctx,
    repo: PROJECT_REPO,
    existing: project,
    reread: () => readProject(ctx, project.id),
    build: (current) => current && { ...current, ...changes, updatedAt: new Date().toISOString() },
    audit: (saved) => ({ action, targetType: 'project', targetId: saved.id, projectId: saved.id, detail })
  });
  if (result.status !== 'ok') return result;
  return { status: 'ok', value: viewOf(result.value), created };
}

/** Loads the project for a write, or the refusal that stops it. */
async function writable(ctx, id) {
  const project = await readProject(ctx, id);
  if (!project) return { refused: { status: 'not-found', error: 'Project not found.' } };
  const refused = refusal(ctx, project);
  return refused ? { refused } : { project };
}

/**
 * The CAC fields of a project the caller may read; `null` for an unknown project. No member list:
 * DEMI holds no member store, and eagle-notify has no route that lists them.
 */
async function get(access, id) {
  const project = await projects.getById(access, id);
  return project ? viewOf(project) : null;
}

/** Sets up the CAC, unpublished (cac.js:192). */
async function create(ctx, id, input) {
  const checked = checkEmail(CREATE_SCHEMA, input);
  if (checked.status !== 'ok') return checked;
  const { project, refused } = await writable(ctx, id);
  if (refused) return refused;
  return writeFields(ctx, project,
    { projectCAC: true, cacEmail: checked.value.cacEmail, projectCACPublished: false }, 'cac.create', { created: true });
}

/** Publishes the CAC (cac.js:23). Unlike eagle-api, a project with no CAC is refused. */
async function publish(ctx, id) {
  const { project, refused } = await writable(ctx, id);
  if (refused) return refused;
  if (project.projectCAC !== true) return { status: 'conflict', error: 'The project has no CAC.' };
  return writeFields(ctx, project, { projectCACPublished: true }, 'cac.publish');
}

/** Unpublishes the CAC (cac.js:50). */
async function unpublish(ctx, id) {
  const { project, refused } = await writable(ctx, id);
  if (refused) return refused;
  return writeFields(ctx, project, { projectCACPublished: false }, 'cac.unpublish');
}

/**
 * Ends every member's subscription in eagle-notify, then sets `projectCAC` false (cac.js:221-225).
 * Unlike eagle-api it also unpublishes, so a deleted CAC's email stops showing to the public.
 */
async function remove(ctx, id) {
  const { project, refused } = await writable(ctx, id);
  if (refused) return refused;

  let removed = 0;
  // Members sign up against the Eagle id; a project with none can have no members.
  if (project.eagleId) {
    try {
      ({ count: removed } = await notify.unsubscribeCac(project.eagleId));
    } catch (err) {
      return notifyFailure(err, project.id, 'unsubscribeCac');
    }
  }
  logger.info('[CAC] members unsubscribed for CAC delete', { projectId: project.id, removed });
  return writeFields(ctx, project, { projectCAC: false, projectCACPublished: false }, 'cac.delete',
    { detail: { membersRemoved: removed } });
}

/**
 * Ends one member's subscription in eagle-notify (cac.js:167-169). DEMI stores no member, so no
 * row is written; the answer is the CAC view. An address eagle-notify does not know is already gone.
 */
async function removeMember(ctx, id, input) {
  const checked = checkEmail(REMOVE_MEMBER_SCHEMA, input);
  if (checked.status !== 'ok') return checked;
  const { project, refused } = await writable(ctx, id);
  if (refused) return refused;

  let alreadyRemoved = true;
  if (project.eagleId) {
    try {
      ({ alreadyUnsubscribed: alreadyRemoved } = await notify.unsubscribeCacMember(project.eagleId, checked.value.address));
    } catch (err) {
      if (!(err instanceof notify.NotifyError && err.status === 404 && err.code === 'not_found')) {
        return notifyFailure(err, project.id, 'unsubscribeCacMember');
      }
      logger.info('[CAC] member not subscribed in eagle-notify, treated as removed', { projectId: project.id });
    }
  }
  auditEvent(ctx.req, {
    action: 'cac.member.remove', targetType: 'project', targetId: project.id, projectId: project.id,
    detail: { alreadyRemoved: Boolean(alreadyRemoved) }
  });
  logger.info('[CAC] member removed', { projectId: project.id, alreadyRemoved: Boolean(alreadyRemoved) });
  return { status: 'ok', value: viewOf(project) };
}

module.exports = { get, create, publish, unpublish, remove, removeMember };
