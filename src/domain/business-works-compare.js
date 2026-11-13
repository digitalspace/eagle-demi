'use strict';

// Eagle links for sheet interruptions and comment periods, and the report-only comparison of a register
// row with the stored project. Pure; report entries name fields and ids, never a value.

const { PUBLIC_ROLES } = require('../helpers/access-sql');
const { EXTENSION_LIST_FIELDS } = require('../ownership/project');
const { idOf } = require('./extensions');
const { normalizeName } = require('./phase-catalog');
const { dayOf, listOf } = require('./work-model');
const { gapWithin } = require('./work-override');

const ITEM_DAYS = 1;
const PERIOD_DAYS = 3;
/** The Eagle item type of each interruption kind, as eagle-admin's extension form writes it. */
const EAGLE_TYPES = Object.freeze({ extension: 'Extension', suspension: 'Suspension' });
// [reason, register field, stored project field, reader]; status, region and subsector name no stored field.
const COMPARISONS = Object.freeze([
  ['expiryDiffers', 'expiryDate', 'eacExpires', dayOf],
  ['substantialStartDateDiffers', 'substantialStartDate', 'substantiallyDate', dayOf],
  ['ceaaDiffers', 'ceaa', 'CEAAInvolvement', (value) => (typeof value === 'string' && value.trim() ? normalizeName(value) : null)]
]);

const within = (a, b, limit) => gapWithin(a, b, limit) !== null;

function onlyId(ids, reason, list) {
  if (ids.length > 1) list(reason, { candidates: ids });
  return ids.length === 1 ? ids[0] : null;
}

/** `idOf` the one item on the row's extension lists of the same kind and dates within a day, else null. */
function eagleItemIdFor(row, interruption, list) {
  const sameEnd = (end) => (dayOf(end) || interruption.endDate ? within(end, interruption.endDate, ITEM_DAYS) : true);
  const hits = EXTENSION_LIST_FIELDS.flatMap(field => listOf(row && row[field])).filter(item => item && typeof item === 'object' &&
    item.type === EAGLE_TYPES[interruption.kind] && within(item.start, interruption.startDate, ITEM_DAYS) && sameEnd(item.end));
  // Equal Eagle items share one idOf hash, so they are one item here.
  return onlyId([...new Set(hits.map(idOf))], 'eagleItemAmbiguous', list);
}

/** The one public Eagle comment period starting within three days of `start`, else null. */
function commentPeriodIdFor(items, start, list) {
  const hits = listOf(items && items.commentPeriods).filter(period =>
    listOf(period.read).some(role => PUBLIC_ROLES.includes(role)) && within(period.dateStarted, start, PERIOD_DAYS));
  return onlyId(hits.map(hit => hit.id), 'commentPeriodAmbiguous', list);
}

/** Lists each field where the register row and the stored project disagree; never changes a work. */
function compareRegister(stored, row, substantialStart, list) {
  if (!stored) return;
  for (const [reason, sheetField, field, read] of COMPARISONS) {
    if ((read(row[sheetField]) ?? null) !== (read(stored[field]) ?? null)) list(reason, { sheetField, field });
  }
  if (substantialStart && Boolean(substantialStart(row)) !== (stored.substantially === true)) {
    list('substantialStartDiffers', { field: 'substantially' });
  }
}

module.exports = { commentPeriodIdFor, compareRegister, eagleItemIdFor };
