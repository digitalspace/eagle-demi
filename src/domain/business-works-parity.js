'use strict';

// Stored sheet works and override markers against W7's mapping of the extract; pure, so the script does all I/O.

const { PUBLIC_ROLES } = require('../helpers/access-sql');
const { projectOf } = require('../merge/project-of');
const { EXTENSION_LIST_FIELDS } = require('../ownership/project');
const { mapBusinessWorks } = require('./business-works-map');
const { mapperInputs } = require('./business-works-inputs');
const { idOf } = require('./extensions');
const {
  DATE_KEYS, OVERRIDE_TYPES, dayOf, hiddenByOverride, listOf, overrideShown, settledBefore, sourceOf, workTypeCodeOf
} = require('./work-model');

const COUNTS = ['projects', 'works', 'mismatch', 'duplicateSourceKey', 'duplicateExternalId', 'notInCrosswalk', 'noRegisterRow',
  'sheetOutsideCrosswalk', 'markerMissing', 'danglingEagleItemId', 'commentPeriodMissing', 'commentPeriodNotPublic', 'undatedDates',
  'hiddenDrift', 'untilTrackHidden', 'sheetHiddenByMovedBoundary', 'overrideHeldOff'];
const FAILING = ['mismatch', 'duplicateSourceKey', 'duplicateExternalId', 'notInCrosswalk', 'noRegisterRow', 'sheetOutsideCrosswalk',
  'markerMissing'];
const CROSSWALK_REASONS = ['notInCrosswalk', 'noRegisterRow'];
const SKIPPED_PATHS = new Set(['provenance', 'sourceRef', 'links', 'undated']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Throws an error the script exits 2 on; any other error exits 1. */
const refuse = (message) => { throw Object.assign(new Error(message), { refused: true }); };

/** Every date a work holds by path, as a day or else the raw value; list items key on their id, so a reorder is no change. */
function datesOf(value, path = '', out = new Map()) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => datesOf(item, `${path}[${(isObject(item) && (item.id ?? item.catalogId)) ?? i}]`, out));
  } else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (DATE_KEYS.includes(key)) out.set(`${path}.${key}`, child == null ? null : (dayOf(child) ?? child));
      else if (!SKIPPED_PATHS.has(key) && typeof child === 'object') datesOf(child, `${path}.${key}`, out);
    }
  }
  return out;
}

function changedDates(sheet, stored) {
  const [a, b] = [datesOf(sheet), datesOf(stored)];
  return [...new Set([...a.keys(), ...b.keys()])].filter(path => (a.get(path) ?? null) !== (b.get(path) ?? null)).sort();
}

const childrenOf = (work, key) => listOf(work.phases).flatMap(phase => listOf(phase && phase[key])).filter(isObject);
const groupBy = (items, keyOf) => items.reduce((map, item) => map.set(keyOf(item), [...(map.get(keyOf(item)) || []), item]), new Map());

function makeTally() {
  const counts = Object.fromEntries(COUNTS.map(name => [name, 0]));
  const items = [];
  const add = (name, fields) => {
    counts[name]++;
    items.push({ list: name, ...fields });
  };
  return { counts, items, add };
}

/** Stored sheet works against the extract by sourceKey: dates, works missing either side, repeated keys. */
function checkWorks(tally, { all, fresh, sheetWorks, markers }) {
  const mapped = new Map(all.works.map(work => [work.sourceKey, work]));
  const repeated = new Set(all.report.filter(entry => entry.reason === 'duplicateKey').map(entry => entry.sourceKey));
  repeated.forEach(sourceKey => tally.add('duplicateSourceKey', { side: 'sheet', sourceKey }));
  const stored = groupBy(sheetWorks, work => work.sourceKey);
  for (const [sourceKey, works] of stored) {
    if (works.length > 1) tally.add('duplicateSourceKey', { side: 'stored', sourceKey, workIds: works.map(work => work.id).join(',') });
    for (const work of works) {
      const sheet = mapped.get(sourceKey);
      if (!sheet) {
        if (!repeated.has(sourceKey)) tally.add('mismatch', { reason: 'notInSheet', project: work.projectId, workId: work.id, sourceKey });
        continue;
      }
      if (String(sheet.projectId) !== String(work.projectId)) tally.add('mismatch', { reason: 'projectChanged', workId: work.id, sourceKey });
      const paths = changedDates(sheet, work);
      if (paths.length) tally.add('mismatch', { reason: 'dateChanged', project: work.projectId, workId: work.id, sourceKey, paths: paths.join(',') });
    }
  }
  // Under an active marker, its trackAlive keys and fresh untilTrack keys it does not name go under hiddenDrift.
  const keyOfId = new Map(sheetWorks.map(work => [work.id, work.sourceKey]));
  const explained = new Set();
  for (const marker of fresh.markers) {
    const held = markers.get(String(marker.projectId));
    if (held?.active !== true) continue;
    // A key the held marker names has a stored work, so only unnamed fresh untilTrack keys can reach notStored.
    marker.untilTrack.forEach(key => explained.add(key));
    listOf(held.trackAlive).forEach(pair => explained.add(pair.sourceKey));
    listOf(held.untilTrack).filter(id => !keyOfId.has(id))
      .forEach(id => tally.add('mismatch', { reason: 'notStored', project: marker.projectId, sheetWorkId: id }));
  }
  for (const work of fresh.works.filter(one => !stored.has(one.sourceKey) && !explained.has(one.sourceKey))) {
    tally.add('mismatch', { reason: 'notStored', project: work.projectId, sourceKey: work.sourceKey });
  }
}

/** Interruption links to Eagle items absent from the row, milestone links to missing, deleted or private periods. */
function checkLinks(tally, { sheetWorks, rows, commentPeriods }) {
  for (const work of sheetWorks) {
    const row = rows.get(String(work.projectId)) || {};
    const itemIds = new Set(EXTENSION_LIST_FIELDS.flatMap(field => listOf(row[field])).filter(isObject).map(idOf));
    for (const child of childrenOf(work, 'interruptions')) {
      const id = child.links && child.links.eagleItemId;
      if (id && !itemIds.has(id)) tally.add('danglingEagleItemId', { project: work.projectId, workId: work.id, child: child.id });
    }
    const periods = new Map(listOf(commentPeriods.get(String(work.projectId)))
      .filter(period => isObject(period) && period.isDeleted !== true).map(period => [period.id, period]));
    for (const child of childrenOf(work, 'milestones')) {
      const id = child.links && child.links.commentPeriodId;
      if (!id) continue;
      const period = periods.get(id);
      const fields = { project: work.projectId, workId: work.id, child: child.id, commentPeriodId: id };
      if (!period) tally.add('commentPeriodMissing', fields);
      else if (!listOf(period.read).some(role => PUBLIC_ROLES.includes(role))) tally.add('commentPeriodNotPublic', fields);
    }
    if (isObject(work.undated) && Object.keys(work.undated).length) {
      tally.add('undatedDates', { project: work.projectId, workId: work.id, fields: Object.keys(work.undated).sort().join(',') });
    }
  }
}

const pairKey = (trackWorkId, sourceKey) => `${trackWorkId}|${sourceKey}`;

/** The marker's own hidden and trackAlive lists against the fresh ones; returns the Track works that drifted. */
function checkPairs(drift, { marker, freshMarker, keyOf, storedKeys, trackById, boundary, shownIds }) {
  const drifted = new Set();
  const storedHidden = new Set(listOf(marker.hidden).map(pair => pairKey(pair.trackWorkId, keyOf.get(pair.sheetWorkId))));
  const freshHidden = new Set(freshMarker.hidden.map(pair => pairKey(pair.trackWorkId, pair.sourceKey)));
  for (const pair of freshMarker.hidden.filter(one => !storedHidden.has(pairKey(one.trackWorkId, one.sourceKey)))) {
    drifted.add(pair.trackWorkId);
    const shown = !hiddenByOverride(trackById.get(pair.trackWorkId), marker, boundary, shownIds);
    drift('matchNotHidden', { trackWorkId: pair.trackWorkId, sourceKey: pair.sourceKey, shown });
  }
  for (const pair of listOf(marker.hidden)) {
    if (freshHidden.has(pairKey(pair.trackWorkId, keyOf.get(pair.sheetWorkId)))) continue;
    const trackWork = trackById.get(pair.trackWorkId);
    drifted.add(pair.trackWorkId);
    const reason = !trackWork ? 'hiddenTrackGone' : settledBefore(trackWork, boundary) ? 'hiddenNotMatched' : 'hiddenNotSettled';
    drift(reason, { trackWorkId: pair.trackWorkId, sheetWorkId: pair.sheetWorkId });
  }
  const storedAlive = new Set(listOf(marker.trackAlive).map(pair => pairKey(pair.trackWorkId, pair.sourceKey)));
  for (const pair of listOf(marker.trackAlive).filter(one => !trackById.has(one.trackWorkId))) {
    drifted.add(pair.trackWorkId);
    drift('trackAliveGone', { trackWorkId: pair.trackWorkId, sourceKey: pair.sourceKey });
  }
  for (const pair of freshMarker.trackAlive) {
    if (!storedKeys.has(pair.sourceKey) || storedAlive.has(pairKey(pair.trackWorkId, pair.sourceKey)) || drifted.has(pair.trackWorkId)) continue;
    drift('aliveNotSkipped', { trackWorkId: pair.trackWorkId, sourceKey: pair.sourceKey });
  }
}

/** One active marker against W7's pairing over the extract, the stored Track works and the current boundary. */
function checkMarker(tally, { projectId, marker, freshMarker, sheet, track }) {
  // The read's own rule decides which sheet works show and which untilTrack works a Track work replaced.
  const { boundary, replaced, shownSheetIds } = overrideShown(sheet, track, marker);
  const keyOf = new Map(sheet.map(work => [work.id, work.sourceKey]));
  const trackById = new Map(track.map(work => [work.id, work]));
  const drift = (reason, fields) => tally.add('hiddenDrift', { project: projectId, reason, ...fields });
  for (const sheetWorkId of replaced) {
    const by = track.find(trackWork => overrideShown(sheet, [trackWork], marker).replaced.has(sheetWorkId));
    tally.add('untilTrackHidden', { project: projectId, sheetWorkId, sourceKey: keyOf.get(sheetWorkId), trackWorkId: by.id });
  }
  checkPairs(drift, { marker, freshMarker, keyOf, storedKeys: new Set(keyOf.values()), trackById, boundary, shownIds: [...shownSheetIds] });

  const movedKeys = new Set();
  for (const work of sheet.filter(one => OVERRIDE_TYPES.includes(workTypeCodeOf(one)) && !listOf(marker.untilTrack).includes(one.id))) {
    const closed = dayOf(work.decisionDate);
    if (closed && closed >= boundary && closed < marker.boundaryAtLoad) {
      movedKeys.add(work.sourceKey);
      tally.add('sheetHiddenByMovedBoundary', { project: projectId, workId: work.id, sourceKey: work.sourceKey, boundary });
    }
  }
  const replacedKeys = new Set([...replaced].map(id => keyOf.get(id)));
  // An untilTrack id with no stored work is a notStored mismatch, not drift.
  const storedUntil = new Set(listOf(marker.untilTrack).filter(id => keyOf.has(id)).map(id => keyOf.get(id)));
  const freshUntil = new Set(freshMarker.untilTrack);
  for (const sourceKey of [...storedUntil].filter(key => !freshUntil.has(key) && !replacedKeys.has(key))) drift('untilTrackChanged', { sourceKey });
  for (const sourceKey of [...freshUntil].filter(key => !storedUntil.has(key) && !movedKeys.has(key))) drift('untilTrackChanged', { sourceKey });
}

/** (system, value) pairs, values case-blind, that more than one project claims; surrogate extract numbers never count. */
function checkExternalIds(tally, { rows, fresh, numbersReal }) {
  const claims = new Map();
  const claim = (projectId, entry) => {
    if (!isObject(entry) || !entry.system || typeof entry.value !== 'string' || !entry.value) return;
    const key = `${entry.system}:${entry.value.toLowerCase()}`;
    claims.set(key, (claims.get(key) || new Set()).add(String(projectId)));
  };
  for (const row of rows.values()) listOf(row.externalIds).forEach(entry => claim(projectOf(row), entry));
  if (numbersReal) for (const project of fresh.projects) listOf(project.externalIds).forEach(entry => claim(project.projectId, entry));
  for (const [key, projects] of claims) {
    if (projects.size > 1) tally.add('duplicateExternalId', { system: key.split(':')[0], projects: [...projects].sort().join(',') });
  }
}

/** Counts and items from the extract, the stored state and the catalogs. */
function parityOf({ extract, crosswalk, catalog, phaseCatalog, rows, works, markers, commentPeriods, sheetProjectIds = [], at }) {
  const projectIds = [...new Set([...crosswalk.values()].map(String))];
  if (!projectIds.length) refuse('crosswalk holds no project');
  const ofSource = (id, source) => listOf(works.get(id)).filter(work => sourceOf(work) === source);
  const { base, trackWorks } = mapperInputs({
    crosswalk, catalog, phaseCatalog, rows, works, markers, commentPeriods, batchId: 'parity-check', batchAt: at
  });
  const all = mapBusinessWorks(extract, base);
  const fresh = mapBusinessWorks(extract, { ...base, trackWorks, markers });
  const tally = makeTally();
  const sheetWorks = projectIds.flatMap(id => ofSource(id, 'sheet'));
  Object.assign(tally.counts, { projects: projectIds.length, works: sheetWorks.length });
  all.report.filter(entry => CROSSWALK_REASONS.includes(entry.reason))
    .forEach(entry => tally.add(entry.reason, { source: entry.source, ...(entry.ref && { ref: entry.ref }) }));
  [...new Set(sheetProjectIds.map(String))].filter(id => !projectIds.includes(id)).forEach(id => tally.add('sheetOutsideCrosswalk', { project: id }));
  checkWorks(tally, { all, fresh, sheetWorks, markers });
  checkLinks(tally, { sheetWorks, rows, commentPeriods });
  checkExternalIds(tally, { rows, fresh, numbersReal: extract.numbersReal === true });
  fresh.markers.filter(marker => !markers.has(String(marker.projectId))).forEach(marker => tally.add('markerMissing', { project: marker.projectId }));
  for (const [projectId, marker] of markers) {
    if (!dayOf(marker.boundaryAtLoad)) refuse(`marker of project ${projectId} has no valid boundaryAtLoad`);
    const freshMarker = fresh.markers.find(one => String(one.projectId) === projectId) || { hidden: [], trackAlive: [], untilTrack: [] };
    if (marker.active !== true) tally.add('overrideHeldOff', { project: projectId });
    else checkMarker(tally, { projectId, marker, freshMarker, sheet: ofSource(projectId, 'sheet'), track: trackWorks.get(projectId) || [] });
  }
  return tally;
}

module.exports = { COUNTS, FAILING, parityOf, refuse };
