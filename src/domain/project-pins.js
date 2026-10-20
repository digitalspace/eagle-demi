'use strict';

// Pin rules of `PUT /projects/:id`, from eagle-api `api/controllers/pins.js` (docs/eagle-api-port.md, Pins).
// Dark: no caller until F1; the Eagle push owns `pins` and `pinsRead` until then.

const lists = require('../repositories/lists');
const { resolveAccess, systemAccess } = require('../helpers/access-sql');
const { check } = require('./_schema');
const { readWith } = require('./_write');
const { pinsPublished } = require('../vis/predicates');
const { logger } = require('../utils/logger');

/** eagle-api lets these roles add and remove pins (swagger.yaml `/project/{projId}/pin`). */
const PIN_EDITORS = Object.freeze(['sysadmin', 'staff', 'project-system-admin']);

/** eagle-api set no limit; this one keeps the id lookup inside one bounded query. */
const MAX_PINS = 100;

const SCHEMA = Object.freeze({
  pins: { type: 'idArray', max: MAX_PINS },
  pinsPublished: { type: 'boolean' }
});

/** An id, or the `{_id}` label the project read returns, so a read-then-write body is accepted. */
const pinId = (pin) => (pin !== null && typeof pin === 'object' && !Array.isArray(pin) ? pin._id : pin);

/** First occurrence wins, so the caller's order is kept. */
const dedupe = (ids) => Array.from(new Set(ids));

/** The stored list as ids: an Eagle push stores `{_id, name, province}`, a DEMI write bare ids. */
function storedIds(project) {
  const pins = project && Array.isArray(project.pins) ? project.pins : [];
  return pins.map(pinId).filter(id => typeof id === 'string' && id !== '');
}

const sameList = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);

/** The ids in `ids` that `access` can read as organizations. */
async function readableOrgIds(access, ids) {
  if (ids.length === 0) return new Set();
  const rows = await lists.listOrganizationLabels(access, ids);
  return new Set(rows.map(row => String(row.id)));
}

/**
 * The pin fields a PUT body `{pins?, pinsPublished?}` moves on `current`: `{status: 'ok', changes}`, else a refusal.
 * Only ids new to the list are checked, so a list holding a since-unpublished organization can still shrink.
 */
async function pinChanges(ctx, current, body) {
  const input = {};
  if (body.pins !== undefined) input.pins = Array.isArray(body.pins) ? body.pins.map(pinId) : body.pins;
  if (body.pinsPublished !== undefined) input.pinsPublished = body.pinsPublished;
  const checked = check(SCHEMA, input, { partial: true });
  if (checked.status !== 'ok') return checked;

  const before = storedIds(current);
  const pins = input.pins === undefined ? before : dedupe(input.pins);
  const wasPublished = pinsPublished(current);
  const published = input.pinsPublished === undefined ? wasPublished : input.pinsPublished;

  const changes = {};
  if (!sameList(pins, before)) changes.pins = pins;
  if (published !== wasPublished) changes.pinsRead = readWith(current.pinsRead, published);
  if (Object.keys(changes).length === 0) return { status: 'ok', changes };

  const projectId = current.id;
  if (!ctx.access.roles.some(role => PIN_EDITORS.includes(role))) {
    logger.warn('[Project Pins] pin change refused: role', { projectId });
    return { status: 'forbidden', error: `Forbidden. Requires one of the roles ${PIN_EDITORS.join(', ')}.` };
  }

  const held = new Set(before);
  const added = pins.filter(id => !held.has(id));
  const known = await readableOrgIds(systemAccess(), added);
  const unknown = added.filter(id => !known.has(id));
  if (unknown.length) {
    logger.warn('[Project Pins] pin change refused: unknown organizations', { projectId, unknown });
    return { status: 'invalid', fields: { pins: `unknown organization ids: ${unknown.join(', ')}` } };
  }

  // A pin turns public when the list is published, or when it joins an already published list.
  const goingPublic = published ? (wasPublished ? added : pins) : [];
  const open = await readableOrgIds(resolveAccess({}), goingPublic);
  const unpublished = goingPublic.filter(id => !open.has(id));
  if (unpublished.length) {
    logger.warn('[Project Pins] pin change refused: unpublished organizations', { projectId, unpublished });
    return { status: 'conflict', error: `Organizations not published: ${unpublished.join(', ')}` };
  }

  logger.info('[Project Pins] pin change accepted', {
    projectId, fields: Object.keys(changes), pins: pins.length, published
  });
  return { status: 'ok', changes };
}

/**
 * The pins a project read returns, `{_id, name, province}` in stored order. An id the caller cannot
 * read is dropped, as eagle-api's pin read drops an id it cannot find.
 */
async function pinLabels(access, project) {
  const ids = storedIds(project);
  if (ids.length === 0) return [];
  const rows = await lists.listOrganizationLabels(access, ids);
  const byId = new Map(rows.map(row => [String(row.id), row]));
  return ids
    .filter(id => byId.has(id))
    .map(id => ({ _id: id, name: byId.get(id).name || null, province: byId.get(id).province || null }));
}

module.exports = { PIN_EDITORS, MAX_PINS, pinChanges, pinLabels };
