'use strict';

// Pin rules of `PUT /projects/:id`, from eagle-api `api/controllers/pins.js` (docs/eagle-api-port.md, Pins).

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

/** The stored list as ids: a row Eagle pushed before the flip holds `{_id, name, province}`, a DEMI write bare ids. */
function storedIds(project) {
  const pins = project && Array.isArray(project.pins) ? project.pins : [];
  return pins.map(pinId).filter(id => typeof id === 'string' && id !== '');
}

const sameList = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);

/** Organization id -> label row for the ids `access` can read, read in slices of MAX_PINS ids. */
async function labelsById(access, ids) {
  const unique = dedupe(ids);
  const byId = new Map();
  for (let i = 0; i < unique.length; i += MAX_PINS) {
    for (const row of await lists.listOrganizationLabels(access, unique.slice(i, i + MAX_PINS))) {
      byId.set(String(row.id), row);
    }
  }
  return byId;
}

const toLabels = (ids, byId) => dedupe(ids).filter(id => byId.has(id))
  .map(id => ({ _id: id, name: byId.get(id).name || null, province: byId.get(id).province || null }));

/**
 * The list a PUT body's `pins` leaves stored. A body equal to what the caller's read shows
 * (`labelPins`) changes nothing; otherwise the stored ids that read hides are kept, after the sent ones.
 */
async function pinsAfter(access, before, sent) {
  const seen = await labelsById(access, before);
  if (sameList(sent, toLabels(before, seen).map(label => label._id))) return before;
  return dedupe([...sent, ...before.filter(id => !seen.has(id))]);
}

/**
 * The pin fields a PUT body `{pins?, pinsPublished?}` moves on `current`: `{status: 'ok', changes}`, else a refusal.
 * Only ids new to the list are checked, so a list holding a since-unpublished organization can still shrink.
 */
async function pinChanges(ctx, current, body) {
  const input = {};
  // De-duplicated before the check, so MAX_PINS counts distinct organizations.
  if (body.pins !== undefined) input.pins = Array.isArray(body.pins) ? dedupe(body.pins.map(pinId)) : body.pins;
  if (body.pinsPublished !== undefined) input.pinsPublished = body.pinsPublished;
  const checked = check(SCHEMA, input, { partial: true });
  if (checked.status !== 'ok') return checked;

  const before = storedIds(current);
  const pins = input.pins === undefined ? before : await pinsAfter(ctx.access, before, input.pins);
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
  const known = await labelsById(systemAccess(), added);
  const unknown = added.filter(id => !known.has(id));
  if (unknown.length) {
    logger.warn('[Project Pins] pin change refused: unknown organizations', { projectId, unknown });
    return { status: 'invalid', fields: { pins: `unknown organization ids: ${unknown.join(', ')}` } };
  }

  // A pin turns public when the list is published, or when it joins an already published list.
  const goingPublic = published ? (wasPublished ? added : pins) : [];
  const open = await labelsById(resolveAccess({}), goingPublic);
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
 * Each row's `pins`, where the row has them, as `{_id, name, province}` in stored order, with one
 * label read for all rows. An id `access` cannot read is dropped, as eagle-api's pin read drops one it cannot find.
 */
async function labelPins(access, rows) {
  const pinned = rows.filter(row => row && Array.isArray(row.pins));
  const ids = pinned.flatMap(storedIds);
  const byId = ids.length ? await labelsById(access, ids) : new Map();
  for (const row of pinned) row.pins = toLabels(storedIds(row), byId);
  return rows;
}

module.exports = { PIN_EDITORS, MAX_PINS, pinChanges, labelPins };
