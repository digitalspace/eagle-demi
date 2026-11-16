'use strict';

// The mapBusinessWorks options the load (load-business-works.js) and the parity check both pass, so
// the two cannot map one extract differently.

const { listOf, sourceOf } = require('./work-model');

/** A register number: a positive safe integer, else null; the crosswalk skips any other id as `badId`. */
const sheetIdOf = v => (Number.isSafeInteger(v) && v > 0 ? v : null);
const REGISTER_SYSTEM = 'eao-register';
const STAFF_HISTORY = ['staffAssignments', 'staffNotes', 'capitalInvestments'];

/** Whether a stored project row holds what the sheet load writes: register number `number`'s external id or an open staff entry. */
function holdsSheetEntries(row, number) {
  const bySheet = one => one?.source === 'sheet';
  const isNumber = one => bySheet(one) && one.system === REGISTER_SYSTEM && String(one.value) === String(number);
  const isOpen = one => bySheet(one) && (one.effectiveTo ?? null) === null;
  return listOf(row?.externalIds).some(isNumber) || STAFF_HISTORY.some(field => listOf(row?.[field]).some(isOpen));
}

/**
 * `base` for a map without Track works or markers, and `trackWorks` and `markers` to add for the fresh map.
 * `works` and `commentPeriods` are Maps by project id; `rows` is the stored project rows by id; `skipped` is
 * `{state, targetId}` by register number of each row the crosswalk skips.
 */
function mapperInputs({ crosswalk, skipped, catalog, phaseCatalog, rows, works, markers, commentPeriods, batchId, batchAt }) {
  const projectIds = [...new Set([...crosswalk.values()].map(String))];
  const trackOf = id => listOf(works.get(id)).filter(work => sourceOf(work) === 'track' && work.deleted !== true);
  return {
    base: {
      catalog, phaseCatalog, crosswalk, skipped, batchId, batchAt, storedProjects: rows,
      eagleItems: new Map(projectIds.map(id => [id, { ...(rows.get(id) || {}), commentPeriods: listOf(commentPeriods.get(id)) }]))
    },
    trackWorks: new Map(projectIds.map(id => [id, trackOf(id)])),
    markers: new Map([...markers].filter(([, marker]) => marker && marker.deleted !== true))
  };
}

module.exports = { REGISTER_SYSTEM, holdsSheetEntries, mapperInputs, sheetIdOf };
