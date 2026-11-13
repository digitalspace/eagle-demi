'use strict';

// Stored sheet works and override markers against W7's mapping of the extract; pure, so the script does all I/O.

const { PUBLIC_ROLES } = require('../helpers/access-sql');
const { eagleOnlyProjectId } = require('../merge/project');
const { EXTENSION_LIST_FIELDS } = require('../ownership/project');
const { mapBusinessWorks } = require('./business-works-map');
const { idOf } = require('./extensions');
const {
  DATE_KEYS, OVERRIDE_TYPES, dayOf, hiddenByOverride, listOf, overrideBoundaryOf, settledBefore, sourceOf, untilTrackHidden,
  workTypeCodeOf
} = require('./work-model');

const COUNTS = ['projects', 'works', 'mismatch', 'duplicateSourceKey', 'duplicateExternalId', 'notInCrosswalk', 'noRegisterRow',
  'sheetOutsideCrosswalk', 'markerMissing', 'danglingEagleItemId', 'commentPeriodMissing', 'commentPeriodNotPublic', 'undatedDates',
  'hiddenDrift', 'untilTrackHidden', 'sheetHiddenByMovedBoundary', 'overrideHeldOff'];
const FAILING = ['mismatch', 'duplicateSourceKey', 'duplicateExternalId', 'notInCrosswalk', 'noRegisterRow', 'sheetOutsideCrosswalk',
  'markerMissing'];
const CROSSWALK_REASONS = ['notInCrosswalk', 'noRegisterRow'];
const SKIPPED_PATHS = new Set(['provenance', 'sourceRef', 'links', 'undated']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const refuse = (message) => { throw new Error(message); };

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
  // An active marker's trackAlive and the fresh untilTrack keys go under hiddenDrift, not here.
  const active = fresh.markers.filter(marker => markers.get(String(marker.projectId))?.active === true);
  const explained = new Set(active.flatMap(marker => [...marker.untilTrack,
    ...listOf(markers.get(String(marker.projectId)).trackAlive).map(pair => pair.sourceKey)]));
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
  const boundary = overrideBoundaryOf(track);
  const keyOf = new Map(sheet.map(work => [work.id, work.sourceKey]));
  const trackById = new Map(track.map(work => [work.id, work]));
  const drift = (reason, fields) => tally.add('hiddenDrift', { project: projectId, reason, ...fields });
  const hidingTrack = new Map();
  for (const trackWork of track) {
    for (const sheetWorkId of untilTrackHidden(sheet, [trackWork], marker)) if (!hidingTrack.has(sheetWorkId)) hidingTrack.set(sheetWorkId, trackWork.id);
  }
  for (const [sheetWorkId, trackWorkId] of hidingTrack) {
    tally.add('untilTrackHidden', { project: projectId, sheetWorkId, sourceKey: keyOf.get(sheetWorkId), trackWorkId });
  }
  // The read's own rule (works-derive.js withOverride): shown sheet works decide which Track works hide.
  const shownIds = sheet.filter(work => !hidingTrack.has(work.id) && !hiddenByOverride(work, marker, boundary, [])).map(work => work.id);
  checkPairs(drift, { marker, freshMarker, keyOf, storedKeys: new Set(keyOf.values()), trackById, boundary, shownIds });

  const movedKeys = new Set();
  for (const work of sheet.filter(one => OVERRIDE_TYPES.includes(workTypeCodeOf(one)) && !listOf(marker.untilTrack).includes(one.id))) {
    const closed = dayOf(work.decisionDate);
    if (closed && closed >= boundary && closed < marker.boundaryAtLoad) {
      movedKeys.add(work.sourceKey);
      tally.add('sheetHiddenByMovedBoundary', { project: projectId, workId: work.id, sourceKey: work.sourceKey, boundary });
    }
  }
  const replaced = new Set([...hidingTrack.keys()].map(id => keyOf.get(id)));
  const storedUntil = new Set(listOf(marker.untilTrack).map(id => keyOf.get(id)));
  const freshUntil = new Set(freshMarker.untilTrack);
  for (const sourceKey of [...storedUntil].filter(key => !freshUntil.has(key) && !replaced.has(key))) drift('untilTrackChanged', { sourceKey });
  for (const sourceKey of [...freshUntil].filter(key => !storedUntil.has(key) && !movedKeys.has(key))) drift('untilTrackChanged', { sourceKey });
}

/** The project a row's ids count for: a folded twin counts as its target, as project-staff-history.js holds. */
function holderOf(row) {
  const twin = typeof row.eagleId === 'string' && String(row.id) === eagleOnlyProjectId(row.eagleId);
  return String(twin && row.foldedInto != null ? row.foldedInto : row.id);
}

/** (system, value) pairs, values case-blind, that more than one project claims; surrogate extract numbers never count. */
function checkExternalIds(tally, { rows, fresh, numbersReal }) {
  const claims = new Map();
  const claim = (projectId, entry) => {
    if (!isObject(entry) || !entry.system || typeof entry.value !== 'string' || !entry.value) return;
    const key = `${entry.system}:${entry.value.toLowerCase()}`;
    claims.set(key, (claims.get(key) || new Set()).add(String(projectId)));
  };
  for (const row of rows.values()) listOf(row.externalIds).forEach(entry => claim(holderOf(row), entry));
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
  const trackWorks = new Map(projectIds.map(id => [id, ofSource(id, 'track')]));
  const base = {
    catalog, phaseCatalog, crosswalk, batchId: 'parity-check', batchAt: at, storedProjects: rows,
    eagleItems: new Map(projectIds.map(id => [id, { ...(rows.get(id) || {}), commentPeriods: listOf(commentPeriods.get(id)) }]))
  };
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

module.exports = { COUNTS, FAILING, parityOf };
