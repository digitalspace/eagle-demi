'use strict';

/**
 * Project merge engine — Track ⊕ Eagle.
 *
 * DEMI is the central registry, so a project is a MERGED view of two upstream systems:
 *
 *   - epic.track — authoritative for identity and the core attributes it carries
 *   - eagle      — 68 fields of EA-process history Track has none of
 *
 * The join is ONE-DIRECTIONAL: Track carries `epic_guid` (an Eagle `_id`); Eagle carries no
 * Track id. So merging is always driven from the Track side, with Eagle-only projects picked
 * up separately.
 *
 * Measured overlap (382 Track, 359 Eagle): 348 matched · 28 Track without `epic_guid` ·
 * 6 dangling `epic_guid` · ~10 Eagle-only → ~392 projects.
 *
 * Pure functions, no I/O. Merge bugs are SILENT — a wrong rule quietly corrupts the registry
 * instead of erroring — so every rule here is data, and tested as data.
 */

const { eagleBaseAcl } = require('../seed/transform');
const { capRead } = require('../helpers/access-sql');
const { beforeDateFloor } = require('../domain/project-legislation');
const { ASSESSMENT_WORK_TYPE, deriveAssessments } = require('./assessments');
const {
  TRACK_PRECEDENCE, EAGLE_STAFF_FIELDS, EAGLE_ONLY_FIELDS, LEGISLATION_INDEX_FIELDS, LEGISLATION_KEY,
  EAGLE_TOP_LEVEL_FIELDS, PUSH_ONLY_FIELDS, DEMI_ONLY_FIELDS
} = require('../ownership/project');

/** The row id of a project DEMI holds from Eagle alone, before Track matched it. */
const eagleOnlyProjectId = (eagleId) => `eagle-${eagleId}`;
const isEagleOnlyProjectId = (id) => String(id).startsWith(eagleOnlyProjectId(''));

/** Which block is current, the years held, and every `legislation_<year>` block. */
const legislationFields = (eagle) => [...LEGISLATION_INDEX_FIELDS,
  ...Object.keys(eagle).filter(k => LEGISLATION_KEY.test(k))];

/** The `fields` an Eagle record holds a value for: how both merges fill the Eagle-only gaps. */
function pickEagleFields(eagle, fields) {
  const picked = {};
  for (const field of fields) {
    if (hasValue(eagle[field])) picked[field] = eagle[field];
  }
  return picked;
}

/** The fields eagle-api's project model types as `Date`. */
const EAGLE_DATE_FIELDS = [
  'dateUpdated', 'decisionDate', 'eaStatusDate', 'projectStatusDate', 'substantiallyDate',
  'disputeDate', 'activeDate', 'review180Start', 'review45Start'
];

function nullJunkDates(record) {
  for (const field of EAGLE_DATE_FIELDS) {
    if (beforeDateFloor(record[field])) record[field] = null;
  }
}

/**
 * Null the junk Eagle dates on a merged row, top level and every `legislation_<year>` block. A
 * block is copied before it changes: it is shared with `sources.eagle`, which keeps what Eagle sent.
 */
function nullEagleJunkDates(merged) {
  nullJunkDates(merged);
  for (const key of Object.keys(merged)) {
    const block = merged[key];
    if (!LEGISLATION_KEY.test(key) || !block || typeof block !== 'object') continue;
    if (!EAGLE_DATE_FIELDS.some(field => beforeDateFloor(block[field]))) continue;
    merged[key] = { ...block };
    nullJunkDates(merged[key]);
  }
  return merged;
}

const TRANSITION_MILESTONE = 'Project Transitioning FROM';

/**
 * One `{fromYear, toYear, date}` per change of Act. Eagle stores no date, so it comes from Track's
 * optional "Project Transitioning FROM the EA Act (2002)" milestone, matched on the year it names.
 */
function legislationTransitions(yearList, works) {
  const years = [...new Set((Array.isArray(yearList) ? yearList : []).map(Number))]
    .filter(Number.isInteger)
    .sort((a, b) => a - b);
  const pairs = years.slice(1).map((toYear, i) => ({ fromYear: years[i], toYear }));

  const dateByFromYear = new Map();
  for (const work of works) {
    if (!work || work.workTypeId !== ASSESSMENT_WORK_TYPE || !Array.isArray(work.milestones)) continue;
    for (const milestone of work.milestones) {
      if (!milestone || typeof milestone.name !== 'string' ||
          !milestone.name.startsWith(TRANSITION_MILESTONE) || !hasValue(milestone.actualDate)) continue;
      const year = Number((/\b(\d{4})\b/.exec(milestone.name) || [])[1]);
      if (year && !dateByFromYear.has(year)) dateByFromYear.set(year, milestone.actualDate);
    }
  }

  return pairs.map(pair => ({ ...pair, date: dateByFromYear.get(pair.fromYear) ?? null }));
}

/**
 * Put the Eagle slot in the shape `EAGLE_ONLY_FIELDS` names, whatever fed it.
 *
 * eagle-api's push resolves `proponent` and `pins` before it sends them
 * (`api/helpers/demiPush.js`), but the seed reads `/api/public/search?dataset=Project`, which
 * carries neither resolved field: it returns `proponent` as a populated Organization and `pins`
 * as bare ObjectId strings, and no `proponentId`, `proponentName`, `applicableRegulation` or
 * `featuredDocuments` at all (verified against eagle-test, 369/369 rows, 2026-09-07). Without
 * this the seed writes a project whose `proponentId` is null, which is what every row in
 * demi-test held.
 *
 * Only fills what is missing, so it can never overwrite what the push already resolved.
 *
 * @param {object}   flat
 * @param {Map}      [orgs]  Organization `_id` -> `{_id, name, province}`, for `pins`
 */
function normalizeEagleSlot(flat, orgs) {
  if (!flat) return flat;

  if (!hasValue(flat.proponentId) && hasValue(flat.proponent)) {
    const p = flat.proponent;
    if (typeof p === 'object') {
      if (hasValue(p._id)) flat.proponentId = String(p._id);
      // A bare ObjectId carries no name, so proponentName stays absent rather than blank —
      // TRACK_PRECEDENCE then falls back to Track's `proponent_name`.
      if (!hasValue(flat.proponentName) && hasValue(p.name)) flat.proponentName = p.name;
    } else {
      flat.proponentId = String(p);
    }
  }

  // Only with a lookup: a pin rendered as `{name: null}` is worse than one still held as an id.
  // An id the lookup does not know is DROPPED, as it is in the push and in handleGetPins.
  if (orgs && orgs.size && Array.isArray(flat.pins) && flat.pins.some(p => typeof p !== 'object')) {
    flat.pins = flat.pins
      .map(p => (typeof p === 'object' && p !== null ? p : orgs.get(String(p))))
      .filter(Boolean)
      .map(o => ({ _id: String(o._id), name: o.name || null, province: o.province || null }));
  }

  return flat;
}

/** A rebuilt project `read`, capped at the stored row's while DEMI holds it (`levelHeldAt`). */
function heldRead(read, existing) {
  return existing && existing.levelHeldAt && Array.isArray(existing.read)
    ? capRead(read, existing.read)
    : read;
}

/**
 * Carry the DEMI-only fields off the stored row onto a rebuilt one, then derive its assessments. A
 * held row keeps the lower of the rebuilt and stored `read` (`heldRead`): Eagle narrows, never widens.
 */
function carryDemiOnlyFields(merged, existing, fields = DEMI_ONLY_FIELDS) {
  if (!merged) return merged;
  if (existing) {
    for (const field of fields) {
      const value = existing[field];
      if (value !== undefined) merged[field] = Array.isArray(value) ? [...value] : value;
    }
    if (existing.levelHeldAt) {
      merged.read = heldRead(merged.read, existing);
      merged.isPublished = merged.read.includes('public');
    }
  }
  return Object.assign(merged, deriveAssessments(merged, { previous: existing && existing.assessments }));
}

/**
 * Carry forward the Eagle fields a re-merge could not rebuild.
 *
 * A Cosmos upsert replaces the item, so without this a re-seed run to fill `proponentId` would
 * blank the push's enrichment on every row it had already reached. Same rule the `phases` carry
 * already states — an absent feed must not blank a stored value.
 */
function carryEagleOnlyFields(merged, existing) {
  if (!merged || !existing) return merged;
  for (const field of PUSH_ONLY_FIELDS) {
    if (!hasValue(merged[field]) && hasValue(existing[field])) merged[field] = existing[field];
  }

  // `pins` IS in the feed, but as bare ObjectIds — so only the SHAPE is carried, per id, and only
  // for ids still in the feed's list. Membership stays the feed's, which is what lets a pin the
  // EAO removed actually disappear; an id the stored row cannot resolve keeps its bare form rather
  // than being dropped, since nothing here has an Organization lookup to resolve it against.
  if (Array.isArray(merged.pins) && merged.pins.some(p => p !== null && typeof p !== 'object') &&
      Array.isArray(existing.pins)) {
    const stored = new Map(existing.pins
      .filter(p => p && typeof p === 'object' && hasValue(p._id))
      .map(p => [String(p._id), p]));
    merged.pins = merged.pins.map(p =>
      (p !== null && typeof p === 'object' ? p : stored.get(String(p)) || p));
  }

  return merged;
}

/**
 * Normalise an Eagle project to the FLAT shape every rule below is written against: Mongo nests
 * content under `legislation_<year>`, the public search hoists it, the push does not. The block
 * wins over the top level — `region` is declared in both and the top-level copy is stale.
 */
function flattenEagleProject(doc, orgs) {
  if (!doc) return doc;

  const isBlock = k => doc[k] && typeof doc[k] === 'object' && !Array.isArray(doc[k]) &&
    Object.keys(doc[k]).length > 0;
  const legislationKeys = Object.keys(doc).filter(k => LEGISLATION_KEY.test(k));
  const current = doc.currentLegislationYear;

  let key = null;
  // The current block wins named or not: eagle-api does not require `name`, and a sibling must
  // never stand in for it.
  if (typeof current === 'string' && LEGISLATION_KEY.test(current) && isBlock(current)) {
    key = current;
  } else {
    // eagle-api default-fills every Act's block, so only a named one is a real fallback candidate.
    const named = legislationKeys.filter(k => isBlock(k) && hasValue(doc[k].name));
    if (named.length === 1) key = named[0];
  }

  if (!key) {
    // No current block and no single named block: without a top-level name the row would land
    // nameless and published, so reject rather than guess.
    // Copied, not returned as-is: normalising in place would rewrite the caller's own record.
    if (hasValue(doc.name) || legislationKeys.length === 0) {
      return normalizeEagleSlot({ ...doc }, orgs);
    }
    const err = new Error('Eagle project has no resolvable legislation block');
    err.status = 400;
    throw err;
  }

  const flat = { ...doc[key] };
  for (const field of EAGLE_TOP_LEVEL_FIELDS) {
    if (doc[field] !== undefined) flat[field] = doc[field];
  }
  // Every block rides along, so `sources.eagle` can be flattened again under another year.
  for (const k of legislationKeys) flat[k] = doc[k];
  return normalizeEagleSlot(flat, orgs);
}

/**
 * Labels stored trimmed. The index filters on them by exact match, and some Eagle rows carry a
 * trailing space ("Groundwater Extraction ") that no filter value matches. Track sends
 * `proponentName` with one too ("SECURE Waste Infrastructure Corp. ").
 */
const TRIMMED_FIELDS = ['sector', 'projectSubType', 'proponentName'];

function trimLabels(merged) {
  for (const field of TRIMMED_FIELDS) {
    if (typeof merged[field] === 'string') merged[field] = merged[field].trim();
  }
  return merged;
}

function hasValue(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/**
 * British Columbia's bounding box, padded. Every EA project is in BC by definition, so this is
 * a validity test, not a filter: a coordinate outside it is bad data, and plotting it would put
 * a project in another country on the map.
 */
const BC_BBOX = { minLng: -139.5, maxLng: -113.5, minLat: 47.5, maxLat: 60.5 };

function inBC(lng, lat) {
  return lng >= BC_BBOX.minLng && lng <= BC_BBOX.maxLng &&
         lat >= BC_BBOX.minLat && lat <= BC_BBOX.maxLat;
}

// Two Eagle projects store DMS text (53°49'42.9"N); parseFloat would read only the degrees.
const DMS_NUM = String.raw`(\d+(?:\.\d+)?)(?![\d.])`;
const DMS = new RegExp(
  String.raw`^${DMS_NUM}\s*(?:[°º˚d]\s*)?` +
  String.raw`(?:${DMS_NUM}\s*(?:['′’m]\s*)?` +
  String.raw`(?:${DMS_NUM}\s*(?:(?:''|["″”s])\s*)?)?)?` +
  String.raw`([NSEW])$`, 'i');
const DECIMAL = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*[°º˚]?$/;
const HEMISPHERES = { lat: 'NS', lng: 'EW' };

function toDegrees(raw, axis) {
  if (typeof raw === 'number') return raw;
  if (typeof raw !== 'string') return NaN;
  const s = raw.trim();
  const d = DECIMAL.exec(s);
  if (d) return Number(d[1]);
  const m = DMS.exec(s);
  if (!m) return NaN;
  const hemisphere = m[4].toUpperCase();
  if (!HEMISPHERES[axis].includes(hemisphere)) return NaN;
  if (Number(m[2] || 0) >= 60 || Number(m[3] || 0) >= 60) return NaN;
  const deg = Number(m[1]) + Number(m[2] || 0) / 60 + Number(m[3] || 0) / 3600;
  return hemisphere === 'S' || hemisphere === 'W' ? -deg : deg;
}

/**
 * Validate a coordinate pair, repairing the one error that is unambiguous.
 *
 * 7 of the 382 Track records carry a POSITIVE longitude — a dropped minus sign. BC longitude is
 * always negative, so negating is deterministic and recovers 6 of them. The 7th
 * (`Sparwood Wells #04`, lat 45.861 lng 53.354) is not recoverable: Sparwood is at ~49.7,
 * -114.9, so both values are wrong and there is no rule that fixes it. It gets NO centroid
 * rather than an invented one.
 */
function validCoordinates(lngRaw, latRaw) {
  let lng = toDegrees(lngRaw, 'lng');
  const lat = toDegrees(latRaw, 'lat');
  if (isNaN(lng) || isNaN(lat)) return null;

  if (lng > 0 && inBC(-lng, lat)) lng = -lng;
  if (!inBC(lng, lat)) return null;

  return { type: 'Point', coordinates: [lng, lat] };
}

/**
 * Normalise a centroid to GeoJSON `[longitude, latitude]`.
 *
 * Track supplies lat/lng as STRINGS; Eagle supplies a `centroid` in one of several shapes.
 * Coordinate order is the classic bug here. Typesense used to swap to [lat, lng] for its geopoint
 * type; nothing swaps any more — Cosmos stores [lng, lat] and AI Search carries it unchanged — so
 * a wrong order now survives all the way to the map instead of being masked.
 */
function normalizeCentroid(track, eagle) {
  if (track && hasValue(track.longitude) && hasValue(track.latitude)) {
    const fromTrack = validCoordinates(track.longitude, track.latitude);
    if (fromTrack) return fromTrack;
    // Track's value was unusable — fall through to Eagle rather than storing it.
  }

  const c = eagle && eagle.centroid;
  const pair = Array.isArray(c) && c.length === 2 ? c
    : c && Array.isArray(c.coordinates) && c.coordinates.length === 2 ? c.coordinates
      : null;

  return pair ? validCoordinates(pair[0], pair[1]) : null;
}

/**
 * The ACL for a merged project.
 *
 * Eagle already carries a `read[]` in the EPIC role-type vocabulary; preserve it when present so
 * an upstream restriction is never widened by the merge, minus the sealed token (`eagleBaseAcl`).
 *
 * **With no Eagle match, a project is NOT public.** Product owner, 2026-08-23: *"if track has a
 * project that eagle does not have, this project is NOT public."* Eagle is what publishes; a
 * project that has not reached it has not been published by anyone.
 *
 * This reverses the previous rule, which read the Track export as self-evidently public because it
 * is committed to a public repository. That argument was about the FILE, not the projects in it,
 * and it made "Eagle withheld this" indistinguishable from "Eagle never heard of it" — both landed
 * on `public`. Measured before the change: 28 projects were anonymously readable in demi-test with
 * no Eagle counterpart, and 19 of the 27 checked returned zero anonymous hits on prod eagle-search.
 *
 * Failing closed here is also right for the Eagle-only path (`mergeEagleOnlyProject`), where a
 * missing or empty `read[]` on an Eagle record is an absence of evidence, not evidence of consent.
 */
function resolveProjectAcl(eagle) {
  // Level 2 when Eagle sent none, or only the sealed token: the level the legacy admin-role list
  // already meant, written in ladder tokens so a re-merge does not rewrite what a controller wrote.
  return eagleBaseAcl(eagle && eagle.read);
}

/**
 * Merge one Track project with its optional Eagle counterpart.
 *
 * @param {object}      track  a Track project in the flat shape `trackApiToExtract` produces
 * @param {object|null} eagle  the Eagle project matched via track.epic_guid
 * @param {object}      [opts]
 * @param {string}      [opts.now]     ISO timestamp, injected for deterministic tests
 * @param {Array}       [opts.phases]  this project's Track work phases (seed/sources.js)
 * @param {Array}       [opts.works]   this project's Track works (seed/sources.js); absent when
 *                                     not fetched, which also leaves `legislationTransitions` out
 * @param {Map}         [opts.orgs]    Organization lookup, for resolving seed-shaped `pins`
 */
function mergeTrackProject(track, eagleRaw, opts = {}) {
  if (!track || !hasValue(track.track_project_id)) {
    throw new TypeError('[merge] a Track project with track_project_id is required');
  }

  // Here, not at the call sites: the push hands over a raw Mongo doc and the seed a flat one.
  const eagle = flattenEagleProject(eagleRaw, opts.orgs);

  const now = opts.now || new Date().toISOString();
  const id = String(track.track_project_id);

  // isPublished MIRRORS the ACL — it is never an independent signal.
  //
  // It used to be `track.is_active !== false`, which conflated two unrelated things. `is_active`
  // is a Track-internal record flag, not a publication or lifecycle state: of the 40 projects it
  // marks inactive, 17 are "Pre Work", 8 "Under Work" and 2 "Operation", while only 12 of the 109
  // "Closed" projects carry it. That produced 23 projects — Ajax Mine, Aurora LNG Digby Island —
  // reading `isPublished: false` while Eagle's ACL correctly made them publicly visible. Nothing
  // leaked, but the mirror lied, and setDocumentPublished 409s against an unpublished parent, so
  // no document could be published under any of them.
  //
  // `is_active` is still carried through, as `isActive` via TRACK_PRECEDENCE.
  const read = resolveProjectAcl(eagle);
  const isPublished = read.includes('public');

  const merged = {
    id,
    trackProjectId: Number(track.track_project_id),
    eagleId: hasValue(track.epic_guid) ? String(track.epic_guid) : null,
    sourceSystem: 'track',
    isPublished,
    read,
    updatedAt: now
  };

  // Track wins — but only where Track actually has a value.
  for (const [target, trackField, eagleField] of TRACK_PRECEDENCE) {
    const trackValue = track[trackField];
    if (hasValue(trackValue)) {
      merged[target] = trackValue;
      continue;
    }
    const eagleValue = eagleField && eagle ? eagle[eagleField] : undefined;
    if (hasValue(eagleValue)) merged[target] = eagleValue;
  }

  // Eagle fills the gaps Track cannot.
  if (eagle) Object.assign(merged, pickEagleFields(eagle, [...EAGLE_ONLY_FIELDS, ...legislationFields(eagle)]));

  // Track-only, and no contest with Eagle: `currentPhaseName` and `phaseHistory` are Eagle's own
  // EA-process record and stay exactly as they are. This is the dated assessment rail, and it is
  // omitted rather than emptied when Track has none — an absent feed must not blank a stored one.
  if (Array.isArray(opts.phases) && opts.phases.length) merged.phases = opts.phases;
  // Same rule for the works. The transitions are rebuilt whenever works were fetched, even none,
  // since an empty list still says Track has no transition date.
  if (Array.isArray(opts.works)) {
    if (opts.works.length) merged.works = opts.works;
    merged.legislationTransitions = legislationTransitions(merged.legislationYearList, opts.works);
  }
  nullEagleJunkDates(merged);
  trimLabels(merged);

  const centroid = normalizeCentroid(track, eagle);
  if (centroid) merged.centroid = centroid;

  // Raw payloads retained unindexed, so a re-merge never needs to re-fetch upstream and any
  // field can be traced to its source.
  //
  // Storage only. This used to claim the API never read it, which was not true: the project
  // controller and the search fallback both returned it verbatim on anonymous routes. What keeps
  // it off the wire is the field catalog (`src/vis/catalog/projects.js`, `sources` at maxVis 0),
  // applied at res.json — not this comment, and not the read ACL, which gates rows rather than
  // fields.
  merged.sources = {
    track,
    eagle: eagle || null
  };

  return merged;
}

/**
 * An Eagle project with no Track counterpart.
 *
 * Included rather than dropped so nothing disappears, and flagged `sourceSystem: 'eagle'` so
 * it is identifiable for later reconciliation with Track. Keyed by its Eagle `_id`, since
 * there is no Track id to use.
 */
function mergeEagleOnlyProject(eagleRaw, opts = {}) {
  const eagle = flattenEagleProject(eagleRaw, opts.orgs);
  if (!eagle || !hasValue(eagle._id)) {
    throw new TypeError('[merge] an Eagle project with _id is required');
  }

  const now = opts.now || new Date().toISOString();
  const eagleId = String(eagle._id);

  // Same rule as the Track path: the flag mirrors the ACL rather than a separate status field.
  const read = resolveProjectAcl(eagle);
  const isPublished = read.includes('public');

  const merged = {
    id: eagleOnlyProjectId(eagleId),
    trackProjectId: null,
    eagleId,
    sourceSystem: 'eagle',
    isPublished,
    read,
    updatedAt: now
  };

  for (const [target, , eagleField] of TRACK_PRECEDENCE) {
    if (eagleField && hasValue(eagle[eagleField])) merged[target] = eagle[eagleField];
  }
  Object.assign(merged, pickEagleFields(eagle, [...EAGLE_ONLY_FIELDS, ...legislationFields(eagle)]));
  nullEagleJunkDates(merged);
  trimLabels(merged);

  const centroid = normalizeCentroid(null, eagle);
  if (centroid) merged.centroid = centroid;

  merged.sources = { track: null, eagle };
  return merged;
}

/**
 * Build the full registry from both sources.
 *
 * Returns the merged projects plus a reconciliation report — the report is the point, not a
 * side effect: it is what proves the merge matched what was measured (348/28/6/~10) rather
 * than silently dropping records.
 */
function buildRegistry(trackProjects, eagleProjects, opts = {}) {
  const eagleById = new Map(
    (eagleProjects || []).filter(e => e && e._id).map(e => [String(e._id), e])
  );

  const projects = [];
  const report = {
    trackTotal: (trackProjects || []).length,
    eagleTotal: eagleById.size,
    matched: 0,
    trackOnlyNoGuid: 0,
    trackOnlyDanglingGuid: 0,
    eagleOnly: 0,
    danglingGuids: []
  };

  const consumedEagleIds = new Set();

  for (const track of trackProjects || []) {
    const guid = hasValue(track.epic_guid) ? String(track.epic_guid) : null;
    const eagle = guid ? eagleById.get(guid) || null : null;

    if (eagle) {
      report.matched++;
      consumedEagleIds.add(guid);
    } else if (guid) {
      // A guid that points at nothing: the Eagle project may be unpublished or removed.
      // Counted separately from "no guid at all" because it signals upstream drift.
      report.trackOnlyDanglingGuid++;
      if (report.danglingGuids.length < 20) report.danglingGuids.push(guid);
    } else {
      report.trackOnlyNoGuid++;
    }

    projects.push(mergeTrackProject(track, eagle, opts));
  }

  for (const [eagleId, eagle] of eagleById) {
    if (consumedEagleIds.has(eagleId)) continue;
    report.eagleOnly++;
    projects.push(mergeEagleOnlyProject(eagle, opts));
  }

  report.total = projects.length;
  return { projects, report };
}

/**
 * Registry rows whose `eagleId` is a `ProjectNotification` id rather than an Eagle project id.
 *
 * `buildRegistry` already counts these as `trackOnlyDanglingGuid` — a Track `epic_guid` matching
 * nothing in the Eagle project fetch — which reads as ordinary upstream drift. It is more than
 * that when the guid names a notification: `mergeTrackProject` copies the guid onto `eagleId`, so
 * every period and document Eagle hangs off that notification also resolves to THIS project by
 * eagle id. `helpers/parent-admit.js:pickParent` is what stops the project claiming them; this
 * names the rows, so a run says which projects shadow a notification instead of leaving it to be
 * found from a user-facing zero. Measured 2026-09-08: Track 351 and 353 on test.
 *
 * Not folded into `buildRegistry`: the notification ids are a separate upstream fetch the projects
 * stage never makes. The seed calls this from its documents stage, which already holds them.
 *
 * @param {Array} projects        merged registry rows
 * @param {Set}   notificationIds `ProjectNotification` `_id`s, as strings
 * @returns {Array<{id: string, eagleId: string}>}
 */
function notificationShadowedProjects(projects, notificationIds) {
  if (!notificationIds || notificationIds.size === 0) return [];
  return (projects || [])
    .filter(p => p.eagleId && notificationIds.has(String(p.eagleId)))
    .map(p => ({ id: String(p.id), eagleId: String(p.eagleId) }));
}

/**
 * Index for resolving an upstream identity (an Eagle id or a Track id) to a canonical project.
 *
 * The seeder's documents stage uses it to resolve partition keys, so it must survive any change
 * to what else is being ingested. A deterministic id join only — nothing that resolves by name.
 * Rows that do not resolve are DROPPED rather than given an invented parent — except the
 * documents stage's ProjectNotification carve-out in `scripts/seed-nosql.js`, which admits a
 * second, explicitly enumerated parent id space. Enumerated is the operative word: it admits
 * only ids the notification list itself confirms, so it is still not an invented parent.
 */
function buildProjectIndex(projects) {
  const byEagleId = new Map();
  const byTrackId = new Map();

  for (const p of projects || []) {
    if (p.eagleId) byEagleId.set(String(p.eagleId), p.id);
    if (p.trackProjectId !== null && p.trackProjectId !== undefined) {
      byTrackId.set(String(p.trackProjectId), p.id);
    }
  }

  return {
    /** @returns {string|null} canonical project id, or null when unresolvable */
    resolve(ref) {
      if (!hasValue(ref)) return null;
      const key = String(ref);
      return byEagleId.get(key) || byTrackId.get(key) || null;
    },
    size: byEagleId.size + byTrackId.size
  };
}

module.exports = {
  TRACK_PRECEDENCE,
  EAGLE_ONLY_FIELDS,
  EAGLE_STAFF_FIELDS,
  pickEagleFields,
  EAGLE_TOP_LEVEL_FIELDS,
  flattenEagleProject,
  carryEagleOnlyFields,
  carryDemiOnlyFields,
  heldRead,
  hasValue,
  TRIMMED_FIELDS,
  BC_BBOX,
  validCoordinates,
  normalizeCentroid,
  resolveProjectAcl,
  mergeTrackProject,
  mergeEagleOnlyProject,
  eagleOnlyProjectId,
  isEagleOnlyProjectId,
  buildRegistry,
  buildProjectIndex,
  notificationShadowedProjects
};
