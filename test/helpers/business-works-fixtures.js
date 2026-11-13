'use strict';

const MAP = require('../../src/data/works-catalog-map.json');
const PHASE_MAP = require('../../src/data/phase-catalog-map.json');

// The catalogs as build-works-catalog.js resolves them, with made-up phase ids.
const phaseId = (year, name) => `${year}:${name}`;
const CATALOG = {
  ...MAP, appliedTo: MAP.appliedTo.map(entry => ({ ...entry, catalogIds: { 1996: phaseId(1996, entry.phase), 2002: phaseId(2002, entry.phase) } }))
};
const PHASES = Object.fromEntries([1996, 2002].map(year =>
  [year, PHASE_MAP.acts[year].map(entry => ({ ...entry, catalogId: phaseId(year, entry.name) }))]));

module.exports = { CATALOG, PHASES };
