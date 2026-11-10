'use strict';

const { isoOrNull } = require('../seed/track-mappers');

/**
 * Native list sort keys. Cosmos drops a row lacking the ORDER BY field, so `upsert` writes each (`sortFieldFills`);
 * `eacDecisionSort` stands in for `eacDecision.name`, since filling `eacDecision` would render as a decision.
 */
const SORTABLE = [
  'name', 'dateUpdated', 'proponentName', 'projectType', 'sector', 'region', 'currentPhaseName.name', 'eacDecisionSort'
];

const NULL_WHEN_ABSENT = ['proponentName', 'projectType', 'sector', 'region'];

/** `currentPhaseName` as a ref that holds `name`, or undefined when it already does. A bare id is kept as `_id`. */
function phaseRef(phase) {
  if (phase !== null && typeof phase === 'object') {
    return phase.name === undefined ? { ...phase, _id: phase._id ?? null, name: null } : undefined;
  }
  return { _id: phase ?? null, name: null };
}

/**
 * Writes giving a row every SORTABLE field, leaving held ones alone except `currentPhaseName` (must be a ref with
 * `name`) and a stale `eacDecisionSort`. `dateUpdated` falls back to `dateAdded` (a Date.toString() string), never `_ts`.
 */
function sortFieldFills(row) {
  const fills = {};
  if (row.dateUpdated === undefined) fills.dateUpdated = isoOrNull(row.dateAdded);
  for (const field of NULL_WHEN_ABSENT) {
    if (row[field] === undefined) fills[field] = null;
  }
  const phase = phaseRef(row.currentPhaseName);
  if (phase) fills.currentPhaseName = phase;
  const decision = row.eacDecision && typeof row.eacDecision.name === 'string' ? row.eacDecision.name : null;
  if (row.eacDecisionSort !== decision) fills.eacDecisionSort = decision;
  return fills;
}

module.exports = { SORTABLE, sortFieldFills };
