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

const SECURE_ROLES = ['sysadmin', 'staff', 'demi-admin'];

/**
 * Fields Track owns. Track wins for these, but ONLY when it actually supplies a value:
 * an empty Track field must never blank a populated Eagle one. That is the whole reason this
 * is an explicit map rather than `{...eagle, ...track}` — a spread would overwrite with
 * undefined and silently erase data.
 *
 * `[targetField, trackField, eagleField]` — eagleField null means Eagle has no equivalent.
 */
const TRACK_PRECEDENCE = [
  ['name', 'name', 'name'],
  ['description', 'description', 'description'],
  ['projectType', 'type_name', 'type'],
  ['projectSubType', 'sub_type_name', null],
  ['proponentName', 'proponent_name', null],
  ['projectState', 'project_state_name', 'status'],
  ['abbreviation', 'abbreviation', 'shortName'],
  ['address', 'address', 'location'],
  ['isActive', 'is_active', 'activeStatus']
];

/**
 * Fields only Eagle has. Copied straight across — the EA process record, contacts and CAC
 * data that make DEMI more than a Track mirror.
 */
const EAGLE_ONLY_FIELDS = [
  'eaStatus', 'eacDecision', 'decisionDate', 'currentPhaseName', 'phaseHistory',
  'legislation', 'legislationYear', 'review180Start', 'review45Start',
  'reviewExtensions', 'reviewSuspensions', 'substitution', 'CEAAInvolvement',
  'projectLead', 'projectLeadEmail', 'responsibleEPD', 'responsibleEPDEmail',
  'complianceLead', 'execProjectDirector', 'eaoMember',
  'sector', 'commodity', 'region', 'fedElecDist', 'provElecDist',
  'projectCAC', 'projectCACPublished', 'cacEmail',
  'overallProgress', 'code', 'nameSearchTerms'
];

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
  let lng = parseFloat(lngRaw);
  const lat = parseFloat(latRaw);
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
 * an upstream restriction is never widened by the merge.
 *
 * With no Eagle match, a Track project is PUBLIC. `track_projects_enriched.json` is the public EA
 * project registry — it is committed to a public repository — so every project in it is public
 * information. There is no draft or publication flag in that data to distinguish otherwise.
 */
function resolveProjectAcl(eagle) {
  if (eagle && Array.isArray(eagle.read) && eagle.read.length > 0) {
    return eagle.read;
  }
  return ['public', ...SECURE_ROLES];
}

/**
 * Merge one Track project with its optional Eagle counterpart.
 *
 * @param {object}      track  a record from track_projects_enriched.json
 * @param {object|null} eagle  the Eagle project matched via track.epic_guid
 * @param {object}      [opts]
 * @param {string}      [opts.now]  ISO timestamp, injected for deterministic tests
 */
function mergeTrackProject(track, eagle, opts = {}) {
  if (!track || !hasValue(track.track_project_id)) {
    throw new TypeError('[merge] a Track project with track_project_id is required');
  }

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
  if (eagle) {
    for (const field of EAGLE_ONLY_FIELDS) {
      if (hasValue(eagle[field])) merged[field] = eagle[field];
    }
  }

  const centroid = normalizeCentroid(track, eagle);
  if (centroid) merged.centroid = centroid;

  // Raw payloads retained unindexed, so a re-merge never needs to re-fetch upstream and any
  // field can be traced to its source. Never read directly by the API.
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
function mergeEagleOnlyProject(eagle, opts = {}) {
  if (!eagle || !hasValue(eagle._id)) {
    throw new TypeError('[merge] an Eagle project with _id is required');
  }

  const now = opts.now || new Date().toISOString();
  const eagleId = String(eagle._id);

  // Same rule as the Track path: the flag mirrors the ACL rather than a separate status field.
  const read = resolveProjectAcl(eagle);
  const isPublished = read.includes('public');

  const merged = {
    id: `eagle-${eagleId}`,
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
  for (const field of EAGLE_ONLY_FIELDS) {
    if (hasValue(eagle[field])) merged[field] = eagle[field];
  }

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
 * Index for resolving an NRPTI record's `_epicProjectId` (an Eagle id) to a canonical project.
 *
 * This replaces the entire fuzzy-name-matching apparatus — `normalizeProjectName` with its
 * hardcoded "conuma coal"/"chetwynd" cases, the multi-segment split and the token-inclusion
 * pass. `_epicProjectId` was populated on 200/200 sampled NRPTI records, so the deterministic
 * join is enough. Records that do not resolve are DROPPED rather than given an invented parent.
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
  SECURE_ROLES,
  TRACK_PRECEDENCE,
  EAGLE_ONLY_FIELDS,
  hasValue,
  BC_BBOX,
  validCoordinates,
  normalizeCentroid,
  resolveProjectAcl,
  mergeTrackProject,
  mergeEagleOnlyProject,
  buildRegistry,
  buildProjectIndex
};
