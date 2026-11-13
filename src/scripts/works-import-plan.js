'use strict';

// Pure plan for the business works load: what to write and its hash. works-import-lists.js builds the
// dry-run lists; load-business-works.js reads the inputs and runs the writes.

const { mapBusinessWorks } = require('../domain/business-works-map');
const { OVERRIDE_MARKER_ID, checkSize, dayOf, summaryOf, validateMarker } = require('../domain/work-model');
const { historyEntrySha256 } = require('../repositories/project-staff-history');
const { sha256Hex } = require('../utils/import-envelope');
const { listsOf } = require('./works-import-lists');

const SHEET = 'sheet';
// Ids, run stamps and Cosmos fields differ between two runs over the same input, so no hash covers them.
const UNHASHED = new Set(['id', 'provenance', 'recordedAt', 'batchId', '_etag', '_ts', '_rid', '_self', '_attachments']);
const CLOSEABLE = new Set(['staffAssignments', 'capitalInvestments']);
// What a staff entry says; its id, observedAt, recordedAt and effective days change with the run day.
const STAFF_CONTENT = Object.freeze({
  staffAssignments: ['sheetKey', 'role', 'name'], staffNotes: ['sheetKey', 'text'], capitalInvestments: ['sheetKey', 'amountCad']
});
// W7 saw these works and refused them, so their stored copies stay rather than being tombstoned.
const REFUSED = new Set(['invalid', 'duplicateKey']);

const bodyOf = value => Object.fromEntries(Object.entries(value).filter(([key]) => !UNHASHED.has(key)));
const bodySha256 = value => historyEntrySha256(bodyOf(value));
const staffSha256 = (field, entry) => historyEntrySha256(Object.fromEntries(STAFF_CONTENT[field].map(key => [key, entry[key] ?? null])));
const keyOf = (projectId, sourceKey) => `${projectId}|${sourceKey}`;
const refuse = (message) => { throw new Error(message); };

/** The stored document of a sourceKey, a live one before a tombstone. */
const storedOf = (docs, sourceKey) => docs.filter(doc => doc.sourceKey === sourceKey).sort((a, b) => Number(Boolean(a.deleted)) - Number(Boolean(b.deleted)))[0] || null;

/** Creates and updates for the mapped works, each keeping the stored id of its sourceKey, then removals. */
function worksPlan(mapped, { stored, ownerOf }, report) {
  const entries = [];
  const ids = new Map();
  const kept = new Set(report.filter(one => REFUSED.has(one.reason) && one.sourceKey).map(one => keyOf(one.projectId, one.sourceKey)));
  for (const work of mapped.works) {
    const current = storedOf(stored.get(work.projectId) || [], work.sourceKey);
    const loadReport = (reason, extra) => report.push({ reason, source: 'load', projectId: work.projectId, ...extra });
    if (current && ownerOf(current) !== SHEET) {
      loadReport('ownerNotSheet', { workId: current.id });
      continue;
    }
    const id = current ? current.id : work.id;
    if (!String(id).startsWith(`${SHEET}-`)) refuse(`refused a work id that is not sheet-owned in project ${work.projectId}`);
    const doc = { ...work, id };
    doc.summary = summaryOf(doc);
    kept.add(keyOf(work.projectId, work.sourceKey));
    if (!checkSize(doc).ok) {
      loadReport('oversize', { workId: id, sourceKey: work.sourceKey });
      continue;
    }
    ids.set(keyOf(work.projectId, work.sourceKey), id);
    const sha = bodySha256(doc);
    if (current && !current.deleted && bodySha256(current) === sha) continue;
    entries.push({ action: current ? 'update' : 'create', projectId: work.projectId, sourceKey: work.sourceKey, bodySha256: sha,
      ...(current && { currentSha256: bodySha256(current) }), doc, current });
  }
  for (const [projectId, docs] of stored) {
    for (const current of docs.filter(doc => ownerOf(doc) === SHEET && !doc.deleted && !kept.has(keyOf(projectId, doc.sourceKey)))) {
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

/**
 * The markers the load keeps: fresh ones, plus a turn-off of an active stored marker W7 did not build. Off, not removed, so
 * Track's works show and W8b can reapply it; `deactivatedBy: 'load'` lets a later load turn it back on, unlike a staff revert.
 */
function markersPlan(mapped, ids, { storedMarkers, ownerOf, batchId }, report) {
  const entries = [];
  const docs = [];
  const fresh = new Set(mapped.markers.map(marker => marker.projectId));
  for (const marker of mapped.markers) {
    const current = storedMarkers.get(marker.projectId) || null;
    if (current && ownerOf(current) !== SHEET) {
      report.push({ reason: 'ownerNotSheet', source: 'load', projectId: marker.projectId, workId: OVERRIDE_MARKER_ID });
      continue;
    }
    const { doc, hashed } = markerDocOf(marker, ids, report);
    if (current && current.deactivatedBy === 'load') {
      doc.active = true;
      report.splice(0, report.length, ...report.filter(one => !(one.reason === 'overrideHeldOff' && one.projectId === marker.projectId)));
    }
    const checked = validateMarker(doc);
    if (!checked.ok) refuse(`marker for project ${marker.projectId} fails the validator at ${checked.errors.map(e => e.path).join(', ')}`);
    docs.push(doc);
    if (current && bodySha256(current) === bodySha256(doc)) continue;
    entries.push({ action: 'marker', projectId: marker.projectId, sourceKey: OVERRIDE_MARKER_ID, bodySha256: bodySha256({ ...hashed, active: doc.active }),
      ...(current && { currentSha256: bodySha256(current) }), doc, current });
  }
  for (const [projectId, current] of storedMarkers) {
    if (fresh.has(projectId) || current.active !== true || ownerOf(current) !== SHEET) continue;
    const doc = { ...current, active: false, deactivatedBy: 'load', batchId, provenance: { batchId } };
    docs.push(doc);
    report.push({ reason: 'markerDeactivated', source: 'load', projectId });
    entries.push({ action: 'marker', projectId, sourceKey: OVERRIDE_MARKER_ID, bodySha256: bodySha256(doc), currentSha256: bodySha256(current), doc, current });
  }
  return { entries, docs };
}

/**
 * External ids only for real numbers, staff lists only when the extract carries staff; nothing a row already says.
 * An open sheet entry of a closeable list whose sheetKey the extract does not carry is closed; notes never close.
 */
function staffPlan(mapped, rows, { numbersReal, staffIncluded, batchDate }) {
  const entries = [];
  for (const project of mapped.projects) {
    const row = rows.get(project.projectId);
    const held = row.externalIds || [];
    for (const pair of numbersReal ? project.externalIds : []) {
      if (held.some(one => one.system === pair.system && String(one.value).toLowerCase() === pair.value.toLowerCase())) continue;
      entries.push({ action: 'addExternalId', projectId: project.projectId, system: pair.system, bodySha256: bodySha256(pair), pair });
    }
    for (const field of staffIncluded ? Object.keys(STAFF_CONTENT) : []) {
      const openSheet = (row[field] || []).filter(one => one.source === SHEET && (one.effectiveTo ?? null) === null);
      for (const entry of project[field]) {
        const open = openSheet.filter(one => one.sheetKey === entry.sheetKey);
        if (open.some(one => staffSha256(field, one) === staffSha256(field, entry))) continue;
        const close = CLOSEABLE.has(field) && open.length === 1 ? { id: open[0].id, effectiveTo: batchDate } : null;
        entries.push({ action: 'appendHistory', projectId: project.projectId, field, sheetKey: entry.sheetKey, bodySha256: staffSha256(field, entry),
          ...(close && { currentSha256: staffSha256(field, open[0]) }), entry, close });
      }
      const carried = new Set(project[field].map(entry => entry.sheetKey));
      for (const gone of CLOSEABLE.has(field) ? openSheet.filter(one => !carried.has(one.sheetKey)) : []) {
        entries.push({ action: 'closeHistory', projectId: project.projectId, field, sheetKey: gone.sheetKey, bodySha256: null,
          currentSha256: staffSha256(field, gone), entryId: gone.id, effectiveTo: batchDate });
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

const isRef = value => typeof value === 'string' && value.trim() !== '';

/** Staff writes load only under a keepStaff ref, external ids only under a keepNumbers ref, as the extract was sealed. */
function checkSignoff(extract, entries) {
  const refs = extract.signoffRefs || {};
  const has = (...actions) => entries.some(entry => actions.includes(entry.action));
  if (has('appendHistory', 'closeHistory') && !isRef(refs.keepStaff)) refuse('the plan writes staff entries without a keepStaff sign-off ref');
  if (has('addExternalId') && !isRef(refs.keepNumbers)) refuse('the plan writes external ids without a keepNumbers sign-off ref');
}

/** W7's output less every project with no stored row, each reported once; Track stands for those. */
function withRows(mapped, rows, report) {
  const missing = new Set([...mapped.works, ...mapped.markers, ...mapped.projects].map(one => one.projectId).filter(id => !rows.has(id)));
  missing.forEach(projectId => report.push({ reason: 'projectMissing', source: 'load', projectId }));
  const known = one => !missing.has(one.projectId);
  return { ...mapped, works: mapped.works.filter(known), markers: mapped.markers.filter(known), projects: mapped.projects.filter(known) };
}

/**
 * The whole plan from an opened extract and the stored DEMI state. `mapper` comes from business-works-inputs.js; the rest
 * is `stored` (works by project), `storedMarkers`, `rows`, `trackPublic` and works.js `ownerOf`, which this file may not require.
 */
function buildPlan(extract, { mapper, stored, storedMarkers, rows, trackPublic, ownerOf }) {
  const { base, trackWorks, markers: priorMarkers } = mapper;
  const raw = mapBusinessWorks(extract, { ...base, trackWorks, markers: priorMarkers });
  const report = [...raw.report];
  const mapped = withRows(raw, rows, report);
  const works = worksPlan(mapped, { stored, ownerOf }, report);
  const markers = markersPlan(mapped, works.ids, { storedMarkers, ownerOf, batchId: base.batchId }, report);
  const staff = staffPlan(mapped, rows, {
    numbersReal: extract.numbersReal === true, staffIncluded: extract.staffIncluded === true, batchDate: dayOf(base.batchAt)
  });
  const entries = [...works.entries, ...markers.entries, ...staff];
  checkSignoff(extract, entries);
  const loaded = mapped.works.flatMap(work => (works.ids.has(keyOf(work.projectId, work.sourceKey))
    ? [{ ...work, id: works.ids.get(keyOf(work.projectId, work.sourceKey)) }] : []));
  const lists = listsOf({ loaded, markers: markers.docs, trackWorks, trackPublic: trackPublic || new Map(), report });
  return { entries, planSha256: planSha256Of(entries), report, lists };
}

/** The plan less each addExternalId entry in `held` (another project holds the id), each reported, and hashed again. */
function withoutHeld(plan, held) {
  if (!held.size) return plan;
  const entries = plan.entries.filter(entry => !held.has(entry));
  const report = [...plan.report, ...[...held].map(entry => ({ reason: 'externalIdHeldElsewhere', source: 'load', projectId: entry.projectId, system: entry.system }))];
  return { ...plan, entries, report, planSha256: planSha256Of(entries) };
}

module.exports = { buildPlan, withoutHeld, bodySha256, planSha256Of };
