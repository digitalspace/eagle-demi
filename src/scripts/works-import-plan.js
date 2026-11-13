'use strict';

// Pure plan and report for the business works load: what to write, its hashes, and the dry-run lists.
// The loader (load-business-works.js) reads the inputs and runs the writes.

const { mapBusinessWorks } = require('../domain/business-works-map');
const {
  OVERRIDE_MARKER_ID, OVERRIDE_TYPES, TRACK_FROM, checkSize, dayOf, daysBetween, overrideBoundaryOf, settledBefore,
  summaryOf, transitionOf, validateMarker, workTypeCodeOf
} = require('../domain/work-model');
const { historyEntrySha256 } = require('../repositories/project-staff-history');
const { sha256Hex } = require('../utils/import-envelope');

const SHEET = 'sheet';
// Ids, run stamps and Cosmos fields differ between two runs over the same input, so no hash covers them.
const UNHASHED = new Set(['id', 'provenance', 'recordedAt', 'batchId', '_etag', '_ts', '_rid', '_self', '_attachments']);
const CLOSEABLE = new Set(['staffAssignments', 'capitalInvestments']);
const HISTORY_FIELDS = ['staffAssignments', 'capitalInvestments', 'staffNotes'];
const W7_LISTS = ['trackAlive', 'trackCompletedNoDate', 'sameEventChoice', 'afterBoundary', 'sheetWithoutMarker', 'investmentUseTrack'];

const bodyOf = value => Object.fromEntries(Object.entries(value).filter(([key]) => !UNHASHED.has(key)));
const bodySha256 = value => historyEntrySha256(bodyOf(value));
const keyOf = (projectId, sourceKey) => `${projectId}|${sourceKey}`;
const gapOf = (a, b) => (dayOf(a) && dayOf(b) ? Math.abs(daysBetween(dayOf(a), dayOf(b))) : null);

/** Creates and updates for the mapped works, each keeping the stored id of its sourceKey, then removals. */
function worksPlan(mapped, { stored, ownerOf }, report) {
  const entries = [];
  const ids = new Map();
  for (const work of mapped.works) {
    const current = (stored.get(work.projectId) || []).find(doc => doc.sourceKey === work.sourceKey) || null;
    const loadReport = (reason, extra) => report.push({ reason, source: 'load', projectId: work.projectId, ...extra });
    if (current && ownerOf(current) !== SHEET) {
      loadReport('ownerNotSheet', { workId: current.id });
      continue;
    }
    const id = current ? current.id : work.id;
    if (!String(id).startsWith(`${SHEET}-`)) throw new Error(`refused a work id that is not sheet-owned in project ${work.projectId}`);
    const doc = { ...work, id };
    doc.summary = summaryOf(doc);
    if (!checkSize(doc).ok) {
      loadReport('oversize', { workId: id });
      continue;
    }
    ids.set(keyOf(work.projectId, work.sourceKey), id);
    const sha = bodySha256(doc);
    if (current && !current.deleted && bodySha256(current) === sha) continue;
    entries.push({ action: current ? 'update' : 'create', projectId: work.projectId, sourceKey: work.sourceKey, bodySha256: sha,
      ...(current && { currentSha256: bodySha256(current) }), doc, current });
  }
  const kept = new Set(ids.values());
  for (const [projectId, docs] of stored) {
    for (const current of docs.filter(doc => ownerOf(doc) === SHEET && !doc.deleted && !kept.has(doc.id))) {
      entries.push({ action: 'tombstone', projectId, sourceKey: current.sourceKey, bodySha256: null, currentSha256: bodySha256(current), current });
    }
  }
  return { entries, ids };
}

/**
 * W7's marker with `hidden` and `untilTrack` naming stored sheet work ids, a pair whose sheet work is not loaded dropped;
 * `hashed` keeps sourceKeys, since a work created in this run has a new random id.
 */
function markerDocOf(marker, ids, report) {
  const idOf = sourceKey => ids.get(keyOf(marker.projectId, sourceKey));
  const hidden = marker.hidden.filter(pair => idOf(pair.sourceKey));
  const untilTrack = marker.untilTrack.filter(idOf);
  const dropped = marker.hidden.length + marker.untilTrack.length - hidden.length - untilTrack.length;
  if (dropped) report.push({ reason: 'markerPairDropped', source: 'load', projectId: marker.projectId, count: dropped });
  return {
    hashed: { ...marker, hidden, untilTrack },
    doc: { ...marker, hidden: hidden.map(pair => ({ trackWorkId: pair.trackWorkId, sheetWorkId: idOf(pair.sourceKey) })), untilTrack: untilTrack.map(idOf) }
  };
}

function markersPlan(mapped, ids, { storedMarkers, ownerOf }, report) {
  const entries = [];
  const docs = [];
  for (const marker of mapped.markers) {
    const { doc, hashed } = markerDocOf(marker, ids, report);
    docs.push(doc);
    const checked = validateMarker(doc);
    if (!checked.ok) throw new Error(`marker for project ${marker.projectId} fails the validator at ${checked.errors.map(e => e.path).join(', ')}`);
    const current = storedMarkers.get(marker.projectId) || null;
    if (current && ownerOf(current) !== SHEET) {
      report.push({ reason: 'ownerNotSheet', source: 'load', projectId: marker.projectId, workId: OVERRIDE_MARKER_ID });
      continue;
    }
    if (current && bodySha256(current) === bodySha256(doc)) continue;
    entries.push({ action: 'marker', projectId: marker.projectId, sourceKey: OVERRIDE_MARKER_ID, bodySha256: bodySha256(hashed),
      ...(current && { currentSha256: bodySha256(current) }), doc, current });
  }
  return { entries, docs };
}

/** External ids only for real numbers, staff lists only when the extract carries staff; nothing a row already holds. */
function staffPlan(mapped, rows, { numbersReal, staffIncluded, batchDate }) {
  const entries = [];
  for (const project of mapped.projects) {
    const row = rows.get(project.projectId);
    if (!row) continue;
    const held = row.externalIds || [];
    for (const pair of numbersReal ? project.externalIds : []) {
      if (held.some(one => one.system === pair.system && String(one.value).toLowerCase() === pair.value.toLowerCase())) continue;
      entries.push({ action: 'addExternalId', projectId: project.projectId, system: pair.system, bodySha256: bodySha256(pair), pair });
    }
    for (const field of staffIncluded ? HISTORY_FIELDS : []) {
      for (const entry of project[field]) {
        const open = (row[field] || []).filter(one => one.source === SHEET && one.sheetKey === entry.sheetKey && (one.effectiveTo ?? null) === null);
        if (open.some(one => bodySha256(one) === bodySha256(entry))) continue;
        const close = CLOSEABLE.has(field) && open.length === 1 ? { id: open[0].id, effectiveTo: batchDate } : null;
        entries.push({ action: 'appendHistory', projectId: project.projectId, field, sheetKey: entry.sheetKey, bodySha256: bodySha256(entry),
          ...(close && { currentSha256: bodySha256(open[0]) }), entry, close });
      }
    }
  }
  return entries;
}

/** SHA-256 over the sorted hash entries; ids and etags are never part of it. */
function planSha256Of(entries) {
  const hashed = entries.map(({ action, projectId, sourceKey, field, sheetKey, system, bodySha256: body, currentSha256 }) =>
    JSON.stringify({ action, projectId, sourceKey, field, sheetKey, system, bodySha256: body, currentSha256 }));
  return sha256Hex(hashed.sort().join('\n'));
}

const trackItem = (projectId, track) => ({
  projectId, workId: track.id, type: workTypeCodeOf(track), startDate: dayOf(track.startDate), decisionDate: dayOf(track.decisionDate)
});

/** `B` and what set it: `2025`, or the Track Assessment work decided on it. */
function boundaryOf(trackWorks) {
  const day = overrideBoundaryOf(trackWorks);
  const setter = day === TRACK_FROM ? null : trackWorks.find(work => workTypeCodeOf(work) === 'assessment' && dayOf(work.decisionDate) === day);
  return { day, source: setter ? setter.id : '2025' };
}

/** The override lists of one marked project, as the dry run prints them. */
function overrideLists(marker, trackWorks, sheetWorks, lists) {
  const { projectId } = marker;
  const boundary = boundaryOf(trackWorks);
  lists.boundaries.push({ projectId, boundary: boundary.day, source: boundary.source });
  const sheetById = new Map(sheetWorks.map(work => [work.id, work]));
  for (const pair of marker.hidden) {
    const track = trackWorks.find(work => work.id === pair.trackWorkId);
    const sheet = sheetById.get(pair.sheetWorkId);
    lists.trackHidden.push({ ...trackItem(projectId, track), sheetWorkId: pair.sheetWorkId, gap: gapOf(sheet.decisionDate, track.decisionDate) });
  }
  lists.untilTrack.push(...marker.untilTrack.map(sheetWorkId => ({ projectId, sheetWorkId })));
  const paired = new Set(marker.pairedTrackWorkIds);
  for (const track of trackWorks.filter(work => OVERRIDE_TYPES.includes(workTypeCodeOf(work)))) {
    if (settledBefore(track, boundary.day) && !paired.has(track.id)) {
      const near = sheetWorks.filter(work => work.workTypeCode === workTypeCodeOf(track))
        .map(work => ({ sheetWorkId: work.id, gap: gapOf(work.decisionDate, track.decisionDate) }))
        .filter(one => one.gap !== null).sort((a, b) => a.gap - b.gap)[0] || null;
      lists.trackShownNoSheetMatch.push({ ...trackItem(projectId, track), nearest: near });
    } else if (dayOf(track.startDate) && dayOf(track.startDate) < boundary.day && !settledBefore(track, boundary.day)) {
      lists.trackShownStartedBefore.push(trackItem(projectId, track));
    }
  }
}

/** A sheet work told to take its transition day from Track, where Track has no "Project Transitioning FROM" milestone. */
function transitionsMissing(works, trackPublic) {
  return works.filter(work => work.transitionOut && work.transitionOut.dateSource === 'track')
    .filter(work => transitionOf(work.transitionOut, trackPublic.get(work.projectId) || [], work.actYear).source !== 'track')
    .map(work => ({ projectId: work.projectId, workId: work.id, fallbackDate: dayOf(work.transitionOut.date) }));
}

/**
 * The whole plan from an opened extract and the stored DEMI state; `inputs` holds the W7 options plus `stored` (works by
 * project), `storedMarkers`, `rows`, `trackPublic` (Track works in public shape) and works.js `ownerOf`, which this file may not require.
 */
function buildPlan(extract, inputs) {
  const { stored, storedMarkers, rows, trackPublic, ownerOf, ...options } = inputs;
  const mapped = mapBusinessWorks(extract, { ...options, storedProjects: rows });
  const report = [...mapped.report];
  const works = worksPlan(mapped, { stored, ownerOf }, report);
  const markers = markersPlan(mapped, works.ids, { storedMarkers, ownerOf }, report);
  const staff = staffPlan(mapped, rows, {
    numbersReal: extract.numbersReal === true, staffIncluded: extract.staffIncluded === true, batchDate: dayOf(options.batchAt)
  });
  const loaded = mapped.works.flatMap(work => (works.ids.has(keyOf(work.projectId, work.sourceKey))
    ? [{ ...work, id: works.ids.get(keyOf(work.projectId, work.sourceKey)) }] : []));
  const lists = { trackHidden: [], untilTrack: [], trackShownNoSheetMatch: [], trackShownStartedBefore: [], boundaries: [] };
  for (const doc of markers.docs) {
    const trackWorks = (options.trackWorks && options.trackWorks.get(doc.projectId)) || [];
    overrideLists(doc, trackWorks, loaded.filter(work => work.projectId === doc.projectId), lists);
  }
  W7_LISTS.forEach((reason) => { lists[reason] = report.filter(one => one.reason === reason); });
  lists.trackTransitionMissing = transitionsMissing(loaded, trackPublic || new Map());
  lists.sheetShown = loaded.length;
  const entries = [...works.entries, ...markers.entries, ...staff];
  return { entries, planSha256: planSha256Of(entries), report, lists };
}

/** `name=N` lines for stdout: counts only, never an entry. */
function countLines(plan) {
  const { lists } = plan;
  const count = key => (Array.isArray(lists[key]) ? lists[key].length : lists[key]);
  const actions = Object.groupBy(plan.entries, entry => entry.action);
  return [
    ...['create', 'update', 'tombstone', 'marker', 'addExternalId', 'appendHistory'].map(action => `${action}=${(actions[action] || []).length}`),
    ...['trackHidden', 'sheetShown', 'trackShownNoSheetMatch', ...W7_LISTS, 'untilTrack', 'trackShownStartedBefore', 'trackTransitionMissing']
      .map(key => `${key}=${count(key)}`),
    `reportEntries=${plan.report.length}`
  ];
}

module.exports = { buildPlan, countLines, bodySha256, planSha256Of };
