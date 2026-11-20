'use strict';

// The mapBusinessWorks options the load (load-business-works.js) and the parity check both pass, so
// the two cannot map one extract differently.

const { listOf, sourceOf } = require('./work-model');
const { SHEET_ACT_YEARS, keyOf } = require('./business-works-assessment');

/** A register number: a positive safe integer, else null; the crosswalk skips any other id as `badId`. */
const sheetIdOf = v => (Number.isSafeInteger(v) && v > 0 ? v : null);
const REGISTER_SYSTEM = 'eao-register';
const STAFF_HISTORY = ['staffAssignments', 'staffNotes', 'capitalInvestments'];
/** Register column AG "SS?" says the project substantially started. */
const substantialStart = row => keyOf(row.substantialStartFlag) === 'yes';

/** Whether a stored project row holds what the sheet load writes: register number `number`'s external id or an open staff entry. */
function holdsSheetEntries(row, number) {
  const bySheet = one => one?.source === 'sheet';
  const isNumber = one => bySheet(one) && one.system === REGISTER_SYSTEM && String(one.value) === String(number);
  const isOpen = one => bySheet(one) && (one.effectiveTo ?? null) === null;
  return listOf(row?.externalIds).some(isNumber) || STAFF_HISTORY.some(field => listOf(row?.[field]).some(isOpen));
}

/** The phase catalog, refused when an Act the sheets map has no entries: its works would place phases with no catalogId. */
function checkSheetPhases(phaseCatalog, refuse) {
  const empty = SHEET_ACT_YEARS.filter(year => !listOf(phaseCatalog?.[year]).length);
  if (empty.length) refuse(`phase catalog has no entries for ${empty.join(', ')}`);
  return phaseCatalog;
}

/** `base` for a map without Track works or markers, plus the `trackWorks` and `markers` the fresh map adds.
 * `works`, `commentPeriods` and `rows` are Maps by project id; `skipped` is `{state, targetId}` by register number. */
function mapperInputs({ crosswalk, skipped, catalog, phaseCatalog, rows, works, markers, commentPeriods, batchId, batchAt }) {
  const projectIds = [...new Set([...crosswalk.values()].map(String))];
  const trackOf = id => listOf(works.get(id)).filter(work => sourceOf(work) === 'track' && work.deleted !== true);
  return {
    base: {
      catalog, phaseCatalog, crosswalk, skipped, batchId, batchAt, storedProjects: rows, substantialStart,
      eagleItems: new Map(projectIds.map(id => [id, { ...(rows.get(id) || {}), commentPeriods: listOf(commentPeriods.get(id)) }]))
    },
    trackWorks: new Map(projectIds.map(id => [id, trackOf(id)])),
    markers: new Map([...markers].filter(([, marker]) => marker && marker.deleted !== true))
  };
}

module.exports = { REGISTER_SYSTEM, checkSheetPhases, holdsSheetEntries, mapperInputs, sheetIdOf };
