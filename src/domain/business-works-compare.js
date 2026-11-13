'use strict';

// Eagle links for sheet interruptions and comment periods, and the report-only comparison of a register
// row with the stored project. Pure; report entries name fields and ids, never a value.

const { PUBLIC_ROLES } = require('../helpers/access-sql');
const { normalizeName } = require('./phase-catalog');
const { dayOf, daysBetween, listOf } = require('./work-override');

const ITEM_DAYS = 1;
const PERIOD_DAYS = 3;
// [reason, register field, stored project field, reader]; status, region and subsector name no stored field.
const COMPARISONS = Object.freeze([
  ['expiryDiffers', 'expiryDate', 'eacExpires', dayOf],
  ['substantialStartDateDiffers', 'substantialStartDate', 'substantiallyDate', dayOf],
  ['ceaaDiffers', 'ceaa', 'CEAAInvolvement', (value) => (typeof value === 'string' && value.trim() ? normalizeName(value) : null)]
]);

function within(a, b, limit) {
  const [x, y] = [dayOf(a), dayOf(b)];
  return Boolean(x && y) && Math.abs(daysBetween(x, y)) <= limit;
}

function onlyId(hits, reason, list) {
  if (hits.length > 1) list(reason, { candidates: hits.map(hit => hit.id) });
  return hits.length === 1 ? hits[0].id : null;
}

/** The one Eagle extension or suspension item of the same kind and dates within a day, else null. */
function eagleItemIdFor(items, interruption, list) {
  const sameEnd = (end) => (dayOf(end) || interruption.endDate ? within(end, interruption.endDate, ITEM_DAYS) : true);
  const hits = listOf(items && items.extensions).filter(item => (item.type === 'Extension') === (interruption.kind === 'extension') &&
    within(item.start, interruption.startDate, ITEM_DAYS) && sameEnd(item.end));
  return onlyId(hits, 'eagleItemAmbiguous', list);
}

/** The one public Eagle comment period starting within three days of `start`, else null. */
function commentPeriodIdFor(items, start, list) {
  const hits = listOf(items && items.commentPeriods).filter(period =>
    listOf(period.read).some(role => PUBLIC_ROLES.includes(role)) && within(period.dateStarted, start, PERIOD_DAYS));
  return onlyId(hits, 'commentPeriodAmbiguous', list);
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
