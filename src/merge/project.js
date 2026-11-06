'use strict';

// Project merge engine, Track and Eagle. Pure functions, no I/O. Only Track carries the join key
// (`epic_guid`, an Eagle `_id`), so merging runs from the Track side and Eagle-only rows join apart.

const { eagleBaseAcl } = require('../seed/transform');
const { capRead } = require('../helpers/access-sql');
const { DELETED_CEILING } = require('../repositories/documents');
const { beforeDateFloor } = require('../domain/project-legislation');
const { ASSESSMENT_WORK_TYPE, deriveAssessments } = require('./assessments');
const {
  TRACK_PRECEDENCE, SOURCE_FIRST, STAFF_EDITED_AT, STAFF_HELD_FIELDS, EAGLE_STAFF_FIELDS, EAGLE_ONLY_FIELDS, LEGISLATION_INDEX_FIELDS, LEGISLATION_KEY,
  EAGLE_TOP_LEVEL_FIELDS, PUSH_ONLY_FIELDS, DEMI_ONLY_FIELDS, DEMI_OWNED_AT, EXTENSION_LIST_FIELDS, CAC_FIELDS,
  withoutBlockLists
} = require('../ownership/project');

/** The row id of a project DEMI holds from Eagle alone, before Track matched it. */
const eagleOnlyProjectId = (eagleId) => `eagle-${eagleId}`;
const isEagleOnlyProjectId = (id) => String(id).startsWith(eagleOnlyProjectId(''));

/** A project DEMI created: neither Eagle's own row nor a Track one. */
const isNativeProject = (row) => Boolean(row) && row.sourceSystem !== 'eagle' &&
  !isEagleOnlyProjectId(row.id) && !(row.sources && row.sources.track);

/** A project DEMI took over from Eagle: a re-merge keeps its Eagle fields and `read` off the stored row. */
const isDemiOwnedProject = (row) => Boolean(row) && hasValue(row[DEMI_OWNED_AT]);

/** A native row whose `eagleId` is the one sync-out minted for it, not one typed in by staff. */
const isMintedNative = (row) => hasValue(row.eagleId) && row.syncOut?.eagle?.mintedId === String(row.eagleId);

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

/**
 * The Eagle-only fields and every `legislation_<year>` block, each block a copy less the extension
 * lists; `sources.eagle` keeps Eagle's own.
 */
function pickEagleBlocks(eagle) {
  return withoutBlockLists(pickEagleFields(eagle, [...EAGLE_ONLY_FIELDS, ...legislationFields(eagle)]));
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
 * Null the junk Eagle dates on a merged row, top level and every `legislation_<year>` block. Each
 * block is `pickEagleBlocks`' copy, so `sources.eagle` keeps what Eagle sent.
 */
function nullEagleJunkDates(merged) {
  nullJunkDates(merged);
  for (const [key, block] of Object.entries(merged)) {
    if (LEGISLATION_KEY.test(key) && block && typeof block === 'object') nullJunkDates(block);
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
 * Fill `proponentId` and `proponentName` from a populated `proponent`, as the seed's public search
 * sends it; the push sends them resolved. Fills only what is missing.
 */
function normalizeEagleSlot(flat) {
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

  return flat;
}

/** A rebuilt project `read`, capped at the stored row's while DEMI holds it (`levelHeldAt`) or it is deleted. */
function heldRead(read, existing) {
  return existing && (existing.levelHeldAt || existing.isDeleted === true) && Array.isArray(existing.read)
    ? capRead(read, existing.read)
    : read;
}

const EAGLE_SEEDED_FIELDS = ['pinsRead', ...EXTENSION_LIST_FIELDS];

/**
 * Each pin, extension or CAC field the stored row lacks starts from what Eagle sent, `pins` as ids.
 * Eagle holds the value until DEMI takes the field over; once DEMI holds one it owns it.
 */
function seedEagleFields(merged, existing) {
  const eagle = merged.sources && merged.sources.eagle;
  if (!eagle) return;
  const lacks = (field) => !existing || existing[field] === undefined;
  if (lacks('pins') && Array.isArray(eagle.pins)) {
    merged.pins = eagle.pins.map(pin => (pin !== null && typeof pin === 'object' ? pin._id : pin))
      .filter(id => typeof id === 'string' && id !== '');
  }
  for (const field of EAGLE_SEEDED_FIELDS) {
    if (lacks(field) && Array.isArray(eagle[field])) merged[field] = [...eagle[field]];
  }
  for (const field of CAC_FIELDS) {
    if (lacks(field) && hasValue(eagle[field])) merged[field] = eagle[field];
  }
}

/** Copy each of `fields` the stored row holds onto `merged`, each array a copy. */
function carryStored(merged, existing, fields) {
  for (const field of fields) {
    const value = existing[field];
    if (value !== undefined) merged[field] = Array.isArray(value) ? [...value] : value;
  }
}

/** The Eagle-only fields that live in a `legislation_<year>` block, so a year switch lifts them. */
const LEGISLATION_BLOCK_FIELDS = EAGLE_ONLY_FIELDS.filter(field => !EAGLE_TOP_LEVEL_FIELDS.includes(field));

/** Make `key` an owned row's current year, lifting its own copy of the block; Eagle's only when DEMI lacks one. */
function liftOwnedBlock(merged, key) {
  const eagle = (merged.sources && merged.sources.eagle) || {};
  if (!merged[key]) Object.assign(merged, nullEagleJunkDates(pickEagleBlocks({ [key]: eagle[key] })));
  // A stored row with no list starts from Eagle's; the year it leaves stays one to switch back to.
  const yearOfKey = (k) => Number(k.slice(k.indexOf('_') + 1));
  const from = merged.currentLegislationYear ? yearOfKey(merged.currentLegislationYear) : Number(merged.legislationYear);
  const years = ([merged.legislationYearList, eagle.legislationYearList].find(Array.isArray) || []).map(Number);
  merged.legislationYearList = [...new Set([...years, from, yearOfKey(key)].filter(Number.isInteger))].sort((a, b) => a - b);
  const lifted = flattenEagleProject({ [key]: merged[key], currentLegislationYear: key });
  for (const field of LEGISLATION_BLOCK_FIELDS) {
    if (hasValue(lifted[field])) merged[field] = lifted[field];
    else delete merged[field];
  }
  merged.currentLegislationYear = key;
  nullJunkDates(merged);
  trimLabels(merged);
}

/**
 * On an owned row the stored Eagle side stands, an absent field included, minus `drop`. A Track row
 * takes Track's precedence fields, blanks included; with no Track source the stored value stands.
 */
function holdOwnedFields(merged, existing, { drop = [], switchTo } = {}) {
  const blocks = [merged, existing].flatMap(row => Object.keys(row).filter(key => LEGISLATION_KEY.test(key)));
  for (const field of new Set([...EAGLE_ONLY_FIELDS, ...LEGISLATION_INDEX_FIELDS, ...blocks])) {
    const value = existing[field];
    if (value === undefined || drop.includes(field)) delete merged[field];
    else merged[field] = Array.isArray(value) ? [...value] : value;
  }
  if (!(merged.sources && merged.sources.track)) {
    for (const [target] of TRACK_PRECEDENCE) {
      if (hasValue(existing[target])) merged[target] = existing[target];
    }
  }
  // Track's coordinates still win the centroid; else the stored one stands, Eagle's only where it has none.
  const trackCentroid = normalizeCentroid(merged.sources && merged.sources.track, null);
  if (!trackCentroid && hasValue(existing.centroid)) merged.centroid = structuredClone(existing.centroid);
  if (switchTo) liftOwnedBlock(merged, switchTo);
}

/** Each field staff saved (`STAFF_EDITED_AT`) takes the stored value, an absent one included, over both feeds. */
function holdStaffEdits(merged, existing) {
  const stamps = existing && existing[STAFF_EDITED_AT];
  if (!stamps || typeof stamps !== 'object') return merged;
  merged[STAFF_EDITED_AT] = { ...stamps };
  for (const field of STAFF_HELD_FIELDS) {
    if (!hasValue(stamps[field])) continue;
    if (existing[field] === undefined) delete merged[field];
    else merged[field] = structuredClone(existing[field]);
  }
  return merged;
}

/**
 * Carry DEMI's fields off the stored row, then derive assessments: a held row's `read` only narrows (`heldRead`),
 * an owned one keeps its Eagle side and `switchTo` year (`holdOwnedFields`), staff saves stand (`holdStaffEdits`).
 */
function carryDemiOnlyFields(merged, existing, fields = DEMI_ONLY_FIELDS, { drop, switchTo } = {}) {
  if (!merged) return merged;
  const owned = isDemiOwnedProject(existing);
  if (!owned) seedEagleFields(merged, existing);
  if (existing) {
    carryStored(merged, existing, fields);
    if (owned) {
      holdOwnedFields(merged, existing, { drop, switchTo });
      // A delete the rebuild applied still caps the row at staff.
      if (Array.isArray(existing.read)) {
        merged.read = merged.isDeleted === true ? capRead(existing.read, merged.read) : [...existing.read];
        merged.isPublished = merged.read.includes('public');
      }
    } else if (existing.levelHeldAt) {
      merged.read = heldRead(merged.read, existing);
      merged.isPublished = merged.read.includes('public');
    }
    holdStaffEdits(merged, existing);
  }
  return Object.assign(merged, deriveAssessments(merged, { previous: existing && existing.assessments }));
}

/**
 * Carry forward the Eagle fields a re-merge could not rebuild: a Cosmos upsert replaces the item,
 * and an absent feed must not blank a stored value.
 */
function carryEagleOnlyFields(merged, existing) {
  if (!merged || !existing) return merged;
  for (const field of PUSH_ONLY_FIELDS) {
    if (!hasValue(merged[field]) && hasValue(existing[field])) merged[field] = existing[field];
  }
  return merged;
}

/**
 * Flatten an Eagle project's current `legislation_<year>` block to the top level, the shape every
 * rule below reads. The block wins: `region` sits in both and the top-level copy is stale.
 */
function flattenEagleProject(doc) {
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
    // With no top-level name either, the row would land nameless and published: reject, never guess.
    // Copied, so normalising never rewrites the caller's record.
    if (hasValue(doc.name) || legislationKeys.length === 0) {
      return normalizeEagleSlot({ ...doc });
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
  return normalizeEagleSlot(flat);
}

/**
 * Labels stored trimmed: the index filters on exact match, and both feeds send some with a
 * trailing space ("Groundwater Extraction ").
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
 * British Columbia's bounding box, padded. A validity test, not a filter: every EA project is in
 * BC, so a coordinate outside it is bad data.
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
 * A GeoJSON point in BC, or null. A positive longitude is a dropped minus sign (BC is always
 * negative), so it is negated; a pair still outside BC gets no centroid rather than an invented one.
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
 * A GeoJSON `[longitude, latitude]` centroid from Track's lat/lng strings, else Eagle's `centroid`.
 * Nothing downstream swaps the order, so a wrong one here reaches the map.
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

const isDeletedInEagle = (eagle) => Boolean(eagle) && eagle.isDeleted === true;

/**
 * Whether a merge marks the row deleted: `opts.deleted` when the caller decided (a push that says
 * nothing keeps a DEMI delete), else the Eagle copy's own flag.
 */
const mergeDeleted = (eagle, opts) =>
  (typeof opts.deleted === 'boolean' ? opts.deleted : isDeletedInEagle(eagle));

/**
 * A merged project's ACL: Eagle's `read[]` less the sealed token, so the merge never widens it. No
 * Eagle record, or none in `read[]`, fails closed: Eagle is what publishes a project.
 */
function resolveProjectAcl(eagle, deleted = isDeletedInEagle(eagle)) {
  // Level 2 when Eagle sent none, or only the sealed token: the level the legacy admin-role list
  // already meant, written in ladder tokens so a re-merge does not rewrite what a controller wrote.
  const read = eagleBaseAcl(eagle && eagle.read);
  // A deleted project's Eagle `read` still says `public`; the row stays, for staff only.
  return deleted ? capRead(read, DELETED_CEILING) : read;
}

/** Who deleted a stored project: `'eagle'` when its Eagle copy carries the flag, else `'demi'`; null when live. */
function deletedBy(row) {
  if (!row || row.isDeleted !== true) return null;
  return row.sources && row.sources.eagle && row.sources.eagle.isDeleted === true ? 'eagle' : 'demi';
}

/**
 * Whether a rebuild from an Eagle record with no delete flag keeps the stored delete. eagle-api never
 * sends `isDeleted: false`, so only a delete Eagle made (`sources.eagle.isDeleted`) clears.
 */
const deleteStands = (existing) => deletedBy(existing) === 'demi';

/** Set or drop the flag on `row`'s Eagle copy, through a new `sources` so a shallow copy's original keeps its own. */
function markEagleCopy(row, on) {
  const eagle = row.sources && row.sources.eagle;
  if (!on && !(eagle && 'isDeleted' in eagle)) return;
  const { isDeleted: _flag, ...rest } = eagle || {};
  row.sources = { ...row.sources, eagle: on ? { ...rest, isDeleted: true } : rest };
}

/** Flag a project deleted by `by` and cap its `read` at staff, in place: the row stays for staff and reconcile. */
function markDeleted(row, by = 'demi') {
  row.isDeleted = true;
  markEagleCopy(row, by === 'eagle');
  row.read = capRead(row.read, DELETED_CEILING);
  row.isPublished = row.read.includes('public');
  return row;
}

/** Drop the delete flag, in place. `read` stays: widening is the caller's call. */
function clearDeleted(row) {
  delete row.isDeleted;
  markEagleCopy(row, false);
  return row;
}

/** Keep the stored delete on a rebuilt row, in place: a DEMI one always, an Eagle one until Eagle sends the record. */
function carryDelete(row, existing) {
  const by = deletedBy(existing);
  // DEMI owns an owned row's lifecycle: the rebuilt row keeps the stored delete state, either way.
  if (isDemiOwnedProject(existing)) return by ? markDeleted(row, by) : clearDeleted(row);
  if (by === 'demi') return markDeleted(row);
  if (by === 'eagle' && !(row.sources && row.sources.eagle)) return markDeleted(row, 'eagle');
  return row;
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
 * @param {boolean}     [opts.deleted] the row's delete flag; defaults to the Eagle record's
 */
function mergeTrackProject(track, eagleRaw, opts = {}) {
  if (!track || !hasValue(track.track_project_id)) {
    throw new TypeError('[merge] a Track project with track_project_id is required');
  }

  // Here, not at the call sites: the push hands over a raw Mongo doc and the seed a flat one.
  const eagle = flattenEagleProject(eagleRaw);

  const now = opts.now || new Date().toISOString();
  const id = String(track.track_project_id);

  // isPublished mirrors the ACL, never Track's `is_active`: that is a Track record flag, not a
  // publication state.
  const deleted = mergeDeleted(eagle, opts);
  const read = resolveProjectAcl(eagle, deleted);
  const isPublished = read.includes('public');

  const merged = {
    id,
    trackProjectId: Number(track.track_project_id),
    eagleId: hasValue(track.epic_guid) ? String(track.epic_guid) : null,
    sourceSystem: 'track',
    isPublished,
    read,
    ...(deleted ? { isDeleted: true } : {}),
    updatedAt: now
  };

  for (const [target, trackField, eagleField] of TRACK_PRECEDENCE) {
    const trackValue = track[trackField];
    const eagleValue = eagleField && eagle ? eagle[eagleField] : undefined;
    const ordered = SOURCE_FIRST[target] === 'eagle' ? [eagleValue, trackValue] : [trackValue, eagleValue];
    const value = ordered.find(hasValue);
    if (value !== undefined) merged[target] = value;
  }

  // Eagle fills the gaps Track cannot.
  if (eagle) Object.assign(merged, pickEagleBlocks(eagle));

  // Track's dated phases, beside Eagle's own `currentPhaseName` and `phaseHistory`; omitted, not
  // emptied, when Track has none, so an absent feed never blanks a stored one.
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

  // Raw payloads, so a re-merge never re-fetches upstream. Routes do return the row: the field
  // catalog (`sources` at maxVis 0 in src/vis/catalog/projects.js) keeps this off the wire.
  merged.sources = {
    track,
    eagle: eagle || null
  };

  return merged;
}

/**
 * An Eagle project with no Track counterpart: kept, never dropped, flagged `sourceSystem: 'eagle'`
 * and keyed by its Eagle `_id`.
 */
function mergeEagleOnlyProject(eagleRaw, opts = {}) {
  const eagle = flattenEagleProject(eagleRaw);
  if (!eagle || !hasValue(eagle._id)) {
    throw new TypeError('[merge] an Eagle project with _id is required');
  }

  const now = opts.now || new Date().toISOString();
  const eagleId = String(eagle._id);

  // Same rule as the Track path: the flag mirrors the ACL rather than a separate status field.
  const deleted = mergeDeleted(eagle, opts);
  const read = resolveProjectAcl(eagle, deleted);
  const isPublished = read.includes('public');

  const merged = {
    id: eagleOnlyProjectId(eagleId),
    trackProjectId: null,
    eagleId,
    sourceSystem: 'eagle',
    isPublished,
    read,
    ...(deleted ? { isDeleted: true } : {}),
    updatedAt: now
  };

  for (const [target, , eagleField] of TRACK_PRECEDENCE) {
    if (eagleField && hasValue(eagle[eagleField])) merged[target] = eagle[eagleField];
  }
  Object.assign(merged, pickEagleBlocks(eagle));
  nullEagleJunkDates(merged);
  trimLabels(merged);

  const centroid = normalizeCentroid(null, eagle);
  if (centroid) merged.centroid = centroid;

  merged.sources = { track: null, eagle };
  return merged;
}

/**
 * The full registry from both sources, plus the reconciliation report that proves no record was
 * silently dropped.
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
  const nativeRows = (opts.nativeRows || []).filter(isNativeProject);
  const nativeIds = new Set(nativeRows.map(row => String(row.id)));
  if (opts.nativeRows) {
    Object.assign(report, { nativeKept: nativeRows.length, nativeClash: 0, nativeClashes: [], nativeConflicts: [] });
  }
  const nativeById = new Map(nativeRows.map(row => [String(row.id), row]));
  const nativeByEagleId = new Map();
  for (const row of nativeRows.filter(r => hasValue(r.eagleId))) {
    const eagleId = String(row.eagleId);
    const held = nativeByEagleId.get(eagleId);
    if (held) report.nativeConflicts.push({ reason: 'twoNative', eagleId, nativeIds: [String(held.id), String(row.id)] });
    else nativeByEagleId.set(eagleId, row);
    consumedEagleIds.add(eagleId);
  }
  // Native id -> the Track rows that lost its Eagle id here: their stored documents move to it.
  const clashTrackIds = new Map();

  for (const track of trackProjects || []) {
    const trackId = String(track.track_project_id);
    const guid = hasValue(track.epic_guid) ? String(track.epic_guid) : null;
    const own = nativeById.get(trackId);
    if (own) {
      const eagleId = hasValue(own.eagleId) ? String(own.eagleId) : null;
      if (guid && guid !== eagleId) report.nativeConflicts.push({ reason: 'trackGuid', trackId, epicGuid: guid, eagleId });
      continue;
    }
    const native = guid ? nativeByEagleId.get(guid) : null;
    // Only an id sync-out minted for the native row outranks Track's; a second holder makes the
    // write-side Eagle id lookup throw DUPLICATE_ID, so any other clash is the caller's to refuse.
    if (native && isMintedNative(native)) {
      report.nativeClash++;
      if (report.nativeClashes.length < 20) report.nativeClashes.push({ trackId, eagleId: guid });
      const nativeId = String(native.id);
      clashTrackIds.set(nativeId, [...(clashTrackIds.get(nativeId) || []), trackId]);
      projects.push({ ...mergeTrackProject(track, null, opts), eagleId: null });
      continue;
    }
    if (native) report.nativeConflicts.push({ reason: 'shared', trackId, nativeId: String(native.id), eagleId: guid });
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

  projects.push(...nativeRows);
  report.total = projects.length;
  return { projects, report, nativeIds, clashTrackIds };
}

/**
 * `{id, eagleId}` of each row whose `eagleId` is a `ProjectNotification` `_id` (a Set of strings),
 * so a seed run names the projects that shadow a notification (`pickParent` in helpers/parent-admit.js).
 */
function notificationShadowedProjects(projects, notificationIds) {
  if (!notificationIds || notificationIds.size === 0) return [];
  return (projects || [])
    .filter(p => p.eagleId && notificationIds.has(String(p.eagleId)))
    .map(p => ({ id: String(p.id), eagleId: String(p.eagleId) }));
}

/**
 * Resolve an Eagle or Track id to a project id, by id join only, never by name; the seed drops a
 * document that does not resolve rather than invent a parent.
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
  holdStaffEdits,
  heldRead,
  hasValue,
  TRIMMED_FIELDS,
  BC_BBOX,
  validCoordinates,
  normalizeCentroid,
  resolveProjectAcl,
  markDeleted,
  clearDeleted,
  carryDelete,
  deletedBy,
  deleteStands,
  mergeTrackProject,
  mergeEagleOnlyProject,
  eagleOnlyProjectId,
  isEagleOnlyProjectId,
  isNativeProject,
  isDemiOwnedProject,
  isMintedNative,
  buildRegistry,
  buildProjectIndex,
  notificationShadowedProjects
};
