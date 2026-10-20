'use strict';

/**
 * Project extensions and suspensions: `GET` and `POST /projects/:id/extensions`, `PUT` and
 * `DELETE /projects/:id/extensions/:extId`, ported from eagle-api `api/controllers/project.js`
 * (`protectedExtensionAdd`, `Update`, `Delete`; rules in docs/eagle-api-port.md, Extensions).
 *
 * Items live in two arrays on the project row, `reviewExtensions` and `reviewSuspensions`.
 * Nothing on the review timeline is recalculated, as in eagle-api.
 */

const crypto = require('node:crypto');

const projects = require('../repositories/projects');
const { refusedWriteKeys } = require('../vis/redact');
const { check } = require('./_schema');
const { writeRow } = require('./_write');
const { logger } = require('../utils/logger');

const EXTENSIONS = 'reviewExtensions';
const SUSPENSIONS = 'reviewSuspensions';
const LISTS = Object.freeze([EXTENSIONS, SUSPENSIONS]);

/** The fields eagle-admin's extension form sends (extension.component.ts:105-110); the model is Mixed. */
const ITEM_SCHEMA = Object.freeze({
  type: { type: 'string', max: 50 },
  appliedTo: { type: 'string', max: 500 },
  start: { type: 'isoDate', nullable: true },
  end: { type: 'isoDate', nullable: true }
});

/** eagle-api's routing (project.js:490,522,551-552): only type `Extension` is an extension. */
const listFor = (item) => (item.type === 'Extension' ? EXTENSIONS : SUSPENSIONS);

const isItem = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** JSON with object keys sorted, so the same item always hashes the same. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isItem(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * An item's id: the one stored on it, else a hash of its content. Eagle items carry no id (eagle-api
 * matched the whole object, project.js:525-528), so equal items share an id and a delete removes
 * them all, as eagle-api's `$pull` did.
 */
function idOf(item) {
  if (typeof item.id === 'string' && item.id) return item.id;
  return crypto.createHash('sha256').update(canonical(item)).digest('hex').slice(0, 32);
}

const itemsOf = (row, list) => (Array.isArray(row[list]) ? row[list] : []);

/** A list as the caller sees it: each object item with its id. Anything else passes through. */
const withIds = (items) => items.map(item => (isItem(item) ? { ...item, id: idOf(item) } : item));

/** What the controller redacts as a project: both lists and the row keys the dials read. */
function viewOf(row) {
  const view = { id: row.id, read: row.read, isPublished: row.isPublished };
  if (row.vis) view.vis = row.vis;
  for (const list of LISTS) view[list] = withIds(itemsOf(row, list));
  return view;
}

// The redacted view also carries id and the publish flags (pinsPublished wrong without pinsRead).
const bodyOf = (redacted) => Object.fromEntries(LISTS.filter(list => Object.hasOwn(redacted, list))
  .map(list => [list, redacted[list]]));

/** Where `extId` sits: its list and every index holding it (equal Eagle items share one id). */
function locate(row, extId) {
  for (const list of LISTS) {
    const at = itemsOf(row, list).flatMap((item, index) => (isItem(item) && idOf(item) === extId ? [index] : []));
    if (at.length) return { list, at };
  }
  return null;
}

const actorOf = (ctx) => (ctx.req.user && ctx.req.user.preferred_username) || '';
const readProject = (ctx, id) => projects.getById(ctx.access, id);

/** The project repository in the `upsert(row, current)` shape `writeRow` calls. */
const PROJECT_REPO = Object.freeze({
  upsert: (row, current) => projects.upsert(row, { etag: current && current._etag })
});

function auditOf(action, list, extensionId) {
  return (saved) => ({
    action, targetType: 'project', targetId: saved.id, projectId: saved.id, detail: { list, extensionId }
  });
}

/** A list a per-project dial hides from this caller is not theirs to write either. */
function refusal(ctx, project, lists) {
  const refused = refusedWriteKeys(projects.CONTAINER, Object.fromEntries(lists.map(list => [list, true])),
    ctx.access, project);
  if (!refused.length) return null;
  logger.warn('[Extension] write refused: list hidden from caller', { projectId: project.id, lists: refused });
  return { status: 'invalid', fields: Object.fromEntries(refused.map(key => [key, 'is not writable by this caller'])) };
}

function checkItem(input) {
  const checked = check(ITEM_SCHEMA, input);
  if (checked.status !== 'ok') return checked;
  // eagle-api pushed an empty object into reviewSuspensions; DEMI refuses it.
  if (Object.keys(checked.value).length === 0) {
    return { status: 'invalid', fields: { body: 'must name at least one field' } };
  }
  return checked;
}

/** `writeRow` on the project, answering the extensions view instead of the whole row. */
async function writeLists(ctx, existing, build, audit, { created = false } = {}) {
  const result = await writeRow({
    ctx,
    repo: PROJECT_REPO,
    existing,
    reread: () => readProject(ctx, existing.id),
    build: (current) => current && build(current),
    audit
  });
  if (result.status !== 'ok') return result;
  return { status: 'ok', value: viewOf(result.value), created };
}

const stamped = (row) => ({ ...row, updatedAt: new Date().toISOString() });

/**
 * Both lists of a project the caller may read, each item with its id; `null` for an unknown project.
 *
 * @param {object} access
 * @param {string} id the DEMI project id
 */
async function list(access, id) {
  const project = await projects.getById(access, id);
  return project ? viewOf(project) : null;
}

/**
 * Appends a new item, with a new UUID id, to the list its `type` names (project.js:497-501).
 *
 * @param {{access: object, req: object}} ctx
 * @param {string} id the project id
 * @param {object} input `{ type?, appliedTo?, start?, end? }`
 */
async function create(ctx, id, input) {
  const checked = checkItem(input);
  if (checked.status !== 'ok') return checked;

  const project = await readProject(ctx, id);
  if (!project) return { status: 'not-found', error: 'Project not found.' };

  const target = listFor(checked.value);
  const refused = refusal(ctx, project, [target]);
  if (refused) return refused;

  const item = { ...checked.value, id: crypto.randomUUID() };
  logger.info('[Extension] adding item', { projectId: project.id, list: target, by: actorOf(ctx) });
  return writeLists(ctx, project,
    (current) => stamped({ ...current, [target]: [...itemsOf(current, target), item] }),
    auditOf('extension.create', target, item.id),
    { created: true });
}

/**
 * Replaces the item whole: removes it, then appends the body as the item, keeping its id, to the
 * list the new `type` names (project.js:556-570).
 *
 * @param {{access: object, req: object}} ctx
 * @param {string} id the project id
 * @param {string} extId
 * @param {object} input the new item
 */
async function update(ctx, id, extId, input) {
  const checked = checkItem(input);
  if (checked.status !== 'ok') return checked;

  const project = await readProject(ctx, id);
  if (!project) return { status: 'not-found', error: 'Project not found.' };
  const found = locate(project, extId);
  if (!found) return { status: 'not-found', error: 'Extension not found.' };

  const target = listFor(checked.value);
  const refused = refusal(ctx, project, [...new Set([found.list, target])]);
  if (refused) return refused;

  const item = { ...checked.value, id: extId };
  return writeLists(ctx, project, (current) => {
    const now = locate(current, extId);
    if (!now) return null;
    const next = { ...current, [now.list]: itemsOf(current, now.list).filter((_, index) => !now.at.includes(index)) };
    next[target] = [...itemsOf(next, target), item];
    return stamped(next);
  }, auditOf('extension.update', target, extId));
}

/**
 * Removes the item (project.js:525-528).
 *
 * @param {{access: object, req: object}} ctx
 * @param {string} id the project id
 * @param {string} extId
 */
async function remove(ctx, id, extId) {
  const project = await readProject(ctx, id);
  if (!project) return { status: 'not-found', error: 'Project not found.' };
  const found = locate(project, extId);
  if (!found) return { status: 'not-found', error: 'Extension not found.' };

  const refused = refusal(ctx, project, [found.list]);
  if (refused) return refused;

  return writeLists(ctx, project, (current) => {
    const now = locate(current, extId);
    if (!now) return null;
    return stamped({ ...current, [now.list]: itemsOf(current, now.list).filter((_, index) => !now.at.includes(index)) });
  }, auditOf('extension.delete', found.list, extId));
}

module.exports = { ITEM_SCHEMA, bodyOf, idOf, list, create, update, remove };
