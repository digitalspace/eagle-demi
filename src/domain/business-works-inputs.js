'use strict';

// The mapBusinessWorks options the load (load-business-works.js) and the parity check both pass, so
// the two cannot map one extract differently.

const { listOf, sourceOf } = require('./work-model');

/**
 * `base` for a map without Track works or markers, and `trackWorks` and `markers` to add for the fresh map.
 * `works` and `commentPeriods` are Maps by project id; `rows` is the stored project rows by id.
 */
function mapperInputs({ crosswalk, catalog, phaseCatalog, rows, works, markers, commentPeriods, batchId, batchAt }) {
  const projectIds = [...new Set([...crosswalk.values()].map(String))];
  const trackOf = id => listOf(works.get(id)).filter(work => sourceOf(work) === 'track' && work.deleted !== true);
  return {
    base: {
      catalog, phaseCatalog, crosswalk, batchId, batchAt, storedProjects: rows,
      eagleItems: new Map(projectIds.map(id => [id, { ...(rows.get(id) || {}), commentPeriods: listOf(commentPeriods.get(id)) }]))
    },
    trackWorks: new Map(projectIds.map(id => [id, trackOf(id)])),
    markers: new Map([...markers].filter(([, marker]) => marker && marker.deleted !== true))
  };
}

module.exports = { mapperInputs };
