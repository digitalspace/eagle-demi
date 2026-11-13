'use strict';

const MAP = require('../../src/data/works-catalog-map.json');
const PHASE_MAP = require('../../src/data/phase-catalog-map.json');
const { mapBusinessWorks } = require('../../src/domain/business-works-map');

// The catalogs as build-works-catalog.js resolves them, with made-up phase ids.
const phaseId = (year, name) => `${year}:${name}`;
const CATALOG = {
  ...MAP, appliedTo: MAP.appliedTo.map(entry => ({ ...entry, catalogIds: { 1996: phaseId(1996, entry.phase), 2002: phaseId(2002, entry.phase) } }))
};
const PHASES = Object.fromEntries([1996, 2002].map(year =>
  [year, PHASE_MAP.acts[year].map(entry => ({ ...entry, catalogId: phaseId(year, entry.name) }))]));

// Synthetic parity inputs: one register row 101 for PROJECT, its amendments, and Track works beside them.
const PROJECT = 'project-alpha';
const AT = '2026-11-13T00:00:00.000Z';
const CROSSWALK = new Map([[101, PROJECT]]);

const ref = (sheet, slot) => ({ file: 'made-up.xlsx', sheet, row: 5, ...(slot && { slot }) });
const register = (id = 101) => ({
  ref: ref('Projects'), id, name: 'Sample Mine', intakeType: 's.6', intakeDate: '2005-01-01',
  determinationType: 's.10(1)(c)', determinationDate: '2005-03-01', decision: 'EA Certificate Granted', decisionDate: '2008-05-01'
});
const amendment = (slot, startDate, endDate, id = 101) => ({ ref: ref('Amendments', slot), id, name: 'Sample Mine', startDate, endDate });
const extractOf = (...amendments) => ({ records: { projects: [register()], amendments } });
const trackWork = (n, fields) => ({
  id: `track-${n}`, projectId: PROJECT, source: 'track', workTypeId: 7, workState: 'IN_PROGRESS', startDate: null, decisionDate: null, ...fields
});
const settledAmendment = trackWork(500, { workState: 'COMPLETED', startDate: '2010-01-05', decisionDate: '2010-03-02' });
const aliveAmendment = trackWork(501, { startDate: '2010-01-05' });
const decided2018 = trackWork(900, { workTypeId: 6, workState: 'COMPLETED', startDate: '2020-03-01', decisionDate: '2023-10-10' });

/** What a load of `extract` stores, with W8a's sourceKey to sheetWorkId swap on each marker. */
function loaded(extract, trackWorks = []) {
  const result = mapBusinessWorks(extract, {
    catalog: CATALOG, phaseCatalog: PHASES, crosswalk: CROSSWALK, batchId: 'batch-1', batchAt: AT,
    trackWorks: new Map([[PROJECT, trackWorks]])
  });
  const idOfKey = new Map(result.works.map(work => [work.sourceKey, work.id]));
  const markers = new Map(result.markers.map(marker => [marker.projectId, {
    ...marker,
    hidden: marker.hidden.map(pair => ({ trackWorkId: pair.trackWorkId, sheetWorkId: idOfKey.get(pair.sourceKey) })),
    untilTrack: marker.untilTrack.map(key => idOfKey.get(key))
  }]));
  return { works: result.works, markers };
}

/** The stored state the parity check reads, from `loaded` plus Track works and rows. */
const stateOf = ({ works, markers }, { track = [], rows = new Map([[PROJECT, { id: PROJECT }]]), commentPeriods = new Map(), sheetProjectIds = [PROJECT] } = {}) => ({
  rows, works: new Map([[PROJECT, [...works, ...track]]]), markers, commentPeriods, catalog: CATALOG, phaseCatalog: PHASES, sheetProjectIds
});

/** `state` with `child` added to the first phase of the first stored work that has phases. */
function withChild(state, key, child) {
  const at = state.works.findIndex(work => Array.isArray(work.phases) && work.phases.length);
  const works = state.works.map((work, i) => (i !== at ? work : {
    ...work, phases: [{ ...work.phases[0], [key]: [...(work.phases[0][key] || []), child] }, ...work.phases.slice(1)]
  }));
  return { ...state, works };
}

module.exports = {
  CATALOG, PHASES, PROJECT, AT, CROSSWALK, register, amendment, extractOf, trackWork, settledAmendment, aliveAmendment, decided2018,
  loaded, stateOf, withChild
};
