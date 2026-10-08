'use strict';

/**
 * Diff the published Eagle id sets against the rows the Eagle push mirrored into DEMI, and for an
 * id on both sides, the ACL DEMI holds against the one the mirror would write from Eagle's `read[]`.
 *
 * Only the document and comment-period pushes carry a tombstone (`isDeleted: true`); every other
 * container is hard-deleted with none, so the push cannot tell DEMI those rows are gone. This
 * reports both directions and CHANGES NOTHING — a DEMI row absent from Eagle's public search may
 * equally be one Eagle merely unpublished, and eagle-api gives an anonymous caller no way to tell
 * the two apart (see `unpublishedOrDeleted` below), so there is nothing here it is safe to delete.
 *
 *   node src/scripts/reconcile-eagle.js [--json] [--comments] [--engage] [--drop-orphans] [--store]
 *
 * `--drop-orphans` IS THE ONE THING HERE THAT WRITES DATA. Everything else above still holds; see
 * `engageOrphans` for what it deletes and why that one set is safe when no other is. `--store`
 * writes only the run's own report row (`cache.RECONCILE_REPORT_ID`), served by GET /admin/reconcile.
 *
 * It covers the containers the Eagle push and the backfill write: projects, documents, comment
 * periods, lists (both kinds), notifications, updates, and — only with `--comments`, which costs
 * one eagle-api round trip per comment period — comments. Users, groups and inspections are checked
 * against their own stored Eagle copy only (`storedMirrorDrift`).
 *
 * Runs on the devbox via `demi-run` — same recipe as the other database scripts,
 * see README "Running anything against the database". Alert on the one `drift=` line, clean is 0.
 * The API app also runs `run()` nightly on a Functions timer when RECONCILE_SCHEDULE is set — see
 * api/index.js, and azure/modules/observability.bicep for the alert that reads the line.
 *
 * A document or a comment period only counts as `eagleOnly` when DEMI would hold it — its Eagle
 * `project` ref names a project in the merged registry, or a `ProjectNotification`. That is not a
 * rule restated here: `documentAdmission` IS seed-nosql's own function, run over the same merged
 * project registry. The rest report separately under `unresolvedParent`, since the seed and the
 * mirrors drop them too and they are not push drift.
 */

const sources = require('../seed/sources');
const projects = require('../repositories/projects');
const documents = require('../repositories/documents');
const commentPeriods = require('../repositories/comment-periods');
const comments = require('../repositories/comments');
const lists = require('../repositories/lists');
const notifications = require('../repositories/notifications');
const updates = require('../repositories/updates');
const users = require('../repositories/users');
const groups = require('../repositories/groups');
const inspections = require('../repositories/inspections');
const { constrainToProject, DELETED_CEILING } = documents;
const { unlessUnprovisioned } = require('../helpers/unprovisioned');
const { buildRegistry, buildProjectIndex } = require('../merge/project');
const { surplusOf, truncatedReads, documentAdmission } = require('./seed-nosql');
const { eagleBaseAcl, eagleReadUnder } = require('../seed/transform');
const { readUnder } = require('../helpers/update-parent');
const { eachCommentPage } = require('./seed-public-reads');
const { systemAccess, sameAccess } = require('../helpers/access-sql');
const { eagleRef } = require('../helpers/parent-admit');
const cache = require('../repositories/cache');
const { classify } = require('./parity-map');
const { logger } = require('../utils/logger');

/** The containers reported, in the order `report` prints them and `summaryLine` names them. */
const LABELS = ['projects', 'documents', 'commentPeriods', 'lists', 'notifications', 'updates',
  'comments'];
/** The mirrors checked against their own stored Eagle copy — see `storedMirrorDrift`. */
const STORED_LABELS = ['users', 'groups', 'inspections', 'inspectionElements', 'inspectionItems'];

/**
 * The ENGAGE API a period's `metURL` slug is resolved against. NOT the public site host —
 * `engage.eao.gov.bc.ca` is the single-page app, and its nginx answers 200 with `index.html` for
 * every unknown path, so a check pointed there calls every slug alive. The API is the one that
 * answers `/api/slugs/<slug>`. Verified 2026-09-17:
 *   test  https://epic-engage-web-test.apps.gold.devops.gov.bc.ca/api
 *   prod  https://epic-engage-web-prod.apps.gold.devops.gov.bc.ca/api
 * Both come from the site's own `/config/config.js`, which names the API as `VITE_API_URL` — read
 * it rather than composing a hostname, because the public host and the API host are different
 * services and only one of them answers this question.
 *
 * UNSET MEANS SKIP. Guessing a host and getting it wrong reports every live period as an orphan,
 * which is the one outcome a delete flag must not be offered alongside.
 */
const ENGAGE_API_BASE = require('../config').engageApiBase;

/** How long one slug lookup may take before it counts as unknown rather than as an answer. */
const ENGAGE_TIMEOUT_MS = parseInt(process.env.ENGAGE_TIMEOUT_MS || '15000', 10);

function parseArgs(argv) {
  const args = { json: false, comments: false, engage: false, dropOrphans: false, store: false };
  for (const a of argv) {
    if (a === '--json') args.json = true;
    else if (a === '--store') args.store = true;
    else if (a === '--comments') args.comments = true;
    else if (a === '--engage') args.engage = true;
    // The destructive half, and it implies the sweep: there is nothing to drop without one.
    else if (a === '--drop-orphans') { args.engage = true; args.dropOrphans = true; }
    else throw new Error(`[reconcile] unknown argument: ${a}`);
  }
  return args;
}

/**
 * The engagement slug an `isMet` period points at, from the `metURL` the mirror stores.
 *
 * The last non-empty path segment, with any query or fragment cut first. `null` for a URL with no
 * segment to take, OR one whose segment is not a valid percent escape — both are reported as
 * unknown, never as an orphan.
 */
function slugOf(metURL) {
  const raw = String(metURL || '').trim();
  if (!raw) return null;
  const path = raw.split('#')[0].split('?')[0];
  const segments = path.replace(/^[a-z]+:\/\/[^/]+/i, '').split('/').filter(Boolean);
  if (!segments.length) return null;
  try {
    return decodeURIComponent(segments[segments.length - 1]);
  } catch {
    // A malformed escape (e.g. `%zz`) throws URIError; the caller must not see that, or one bad
    // mirrored URL fails the whole reconcile run instead of reporting this one period as unknown.
    return null;
  }
}

/**
 * Does ENGAGE still resolve this slug?
 *
 * THREE ANSWERS, AND ONLY ONE OF THEM IS "GONE". ENGAGE answers a slug it does not hold with
 * `400 {"message": "No engagement slug found for <slug>"}` — verified against the prod API on
 * 2026-09-17 — and that exact shape is the only thing this reads as gone. A 401 (the test host
 * sits behind basic auth), a 404, a 5xx, an HTML body from a host that is not the API, a timeout
 * or a DNS failure are all UNKNOWN: they say the check could not run, not that the engagement was
 * deleted, and a delete driven off them would destroy live rows.
 *
 * A timeout and an outright network failure are both UNKNOWN, and both stay non-destructive — but
 * they are not the same fact, so `reason` names which one it was rather than folding them into one
 * `catch`. Never retried: a slug is checked at most once per reconcile run.
 *
 * @returns {Promise<{state: 'gone'|'live'|'unknown', reason?: string}>}
 */
async function slugState(base, slug, deps = {}) {
  const get = deps.fetch || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENGAGE_TIMEOUT_MS);
  try {
    const res = await get(`${base.replace(/\/+$/, '')}/slugs/${encodeURIComponent(slug)}`,
      { signal: controller.signal });
    if (res.status === 400) {
      // The body is read, not assumed: a 400 from a proxy in front of ENGAGE is not ENGAGE saying
      // the slug is gone, and the two are indistinguishable by status code alone.
      const body = await res.text();
      return { state: /no engagement slug found/i.test(body) ? 'gone' : 'unknown' };
    }
    return { state: res.ok ? 'live' : 'unknown' };
  } catch (err) {
    return { state: 'unknown', reason: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The `isMet` periods whose ENGAGE engagement no longer exists.
 *
 * WHY THESE ARE SAFE TO DELETE WHEN NO OTHER DIFF IS: every other set here is ambiguous because
 * eagle-api cannot tell an anonymous caller "unpublished" from "deleted". This one is not. The row
 * says it is run in ENGAGE and names the engagement; ENGAGE says there is no such engagement. The
 * row therefore renders a link that 404s for every visitor, and there is no reading of it under
 * which it is correct.
 *
 * Cause, as far as it is known: ENGAGE's `delete_from_epic` returns early when
 * `project_tracking_id` is unset, so an engagement deleted before its first successful push leaves
 * the mirror row behind with nothing to retract it.
 *
 * Scale, measured on test 2026-09-17: 18 of 38 `isMet` periods point at a slug ENGAGE no longer
 * holds, and one of the two periods open that day was among them — so a rail that renders open
 * periods ships a dead external link on half its rows without this.
 *
 * @param {object[]} periodRows  every mirrored period
 * @param {object}   opts        {base, drop, periodsRepo, deps}
 * @returns {Promise<{checked, dead, unknown, unknownReasons, dropped, failures}>}
 */
async function engageOrphans(periodRows, { base, drop = false, periodsRepo, deps = {} } = {}) {
  // `unknownReasons` is keyed by period id, and only set for a round trip that actually failed —
  // a metURL with no slug never made one, so it has nothing to attribute a timeout or an error to.
  const result = { checked: 0, dead: [], unknown: [], unknownReasons: {}, dropped: [], failures: [] };
  // `isMet` is the whole population: a period run here has no slug to resolve and no dead link
  // to ship.
  const met = periodRows.filter(row => row.isMet === true);

  for (const row of met) {
    const slug = slugOf(row.metURL);
    if (!slug) {
      result.unknown.push(String(row.id));
      continue;
    }
    result.checked++;
    const { state, reason } = await slugState(base, slug, deps);
    if (state === 'unknown') {
      result.unknown.push(String(row.id));
      if (reason) result.unknownReasons[String(row.id)] = reason;
    }
    if (state !== 'gone') continue;

    result.dead.push(String(row.id));
    if (!drop) continue;
    try {
      await periodsRepo.deleteById(row.id, row.projectId);
      result.dropped.push(String(row.id));
    } catch (err) {
      result.failures.push(`[reconcile] could not drop orphan period ${row.id}: ${err.message}`);
    }
  }
  return result;
}

/**
 * Both directions in one pass.
 *
 * `pushOwned` is why projects need every row carrying an `eagleId` and not just the
 * `sourceSystem: 'eagle'` ones: a Track-sourced row also holds an `eagleId`, so reading only the
 * Eagle-sourced rows would compute ~350 matched projects as missing from DEMI. It is in the
 * membership test and out of the push's own drift.
 *
 * @param {Array}    rows             DEMI rows
 * @param {function} keyOf            row -> the Eagle id it mirrors
 * @param {Set}      eagleIds         ids Eagle currently publishes
 * @param {function} pushOwned        row -> is this row the Eagle push's to keep in step
 * @param {function} parentPublished  eagleId -> is the id's parent project published (default: yes)
 */
function diff(rows, keyOf, eagleIds, pushOwned = () => true, parentPublished = () => true) {
  const inDemi = new Set(rows.map(keyOf));
  const absent = surplusOf(rows, keyOf, eagleIds);
  const missing = [...eagleIds].filter(id => !inDemi.has(id));
  return {
    unpublishedOrDeleted: absent.filter(pushOwned),
    trackOnly: absent.filter(row => !pushOwned(row)),
    eagleOnly: missing.filter(parentPublished),
    unresolvedParent: missing.filter(id => !parentPublished(id))
  };
}


/**
 * Ids in both Eagle and DEMI whose DEMI `read[]` grants different access than the one the mirror
 * would write from Eagle's, or whose `isPublished` has come apart from its own `read[]`. Every
 * id-set diff passes these.
 *
 * @param {Map}      eagleRead     Eagle id -> that record's `read[]`; an id without one is skipped
 * @param {function} parentReadOf  row -> the DEMI parent ACL the mirror narrows against, or null
 * @param {function} derive        (upstream, parentRead) -> the `read[]` the mirror writes
 */
function aclMismatch(rows, keyOf, eagleRead, parentReadOf = () => null, derive = mirroredRead) {
  return rows.filter(row => {
    const upstream = eagleRead.get(keyOf(row));
    if (!upstream) return false;
    const read = Array.isArray(row.read) ? row.read : [];
    const expected = derive(upstream, parentReadOf(row));
    return !sameAccess(read, expected) || row.isPublished !== read.includes('public');
  }).map(keyOf);
}

/** What the document, period, list and notification mirrors write. */
function mirroredRead(upstream, parent) {
  return parent ? eagleReadUnder(upstream, parent) : eagleBaseAcl(upstream);
}

/** What the Update mirror writes: its own rule, `update-parent:readUnder`. */
function updateRead(upstream, parent) {
  return readUnder(upstream, parent && { read: parent });
}

/**
 * Ids whose stored `read[]` is not what the mirror would write from the Eagle copy stored beside
 * it, under its stored parent, or whose `isPublished` has come apart from it. A DEMI seal is kept
 * by the mirror on purpose, so it is skipped; a row without a stored Eagle read has nothing to
 * derive from.
 */
function storedAclMismatch(rows, parentReadOf) {
  return rows.filter(row => {
    if (row.sealedAt || !Array.isArray(row.eagleRead) || row.eagleRead.length === 0) return false;
    const read = Array.isArray(row.read) ? row.read : [];
    const derived = mirroredRead(row.eagleRead, parentReadOf(row));
    const expected = row.isDeleted === true ? constrainToProject(derived, DELETED_CEILING) : derived;
    return !sameAccess(read, expected) || row.isPublished !== read.includes('public');
  }).map(row => String(row.id));
}

/**
 * The user, group and inspection mirrors. eagle-api serves none of them to an anonymous caller,
 * so there is no Eagle id set to diff against: drift here is a row that disagrees with the rule
 * applied to its own stored Eagle copy and its stored parent, and a child whose parent row is gone.
 */
async function storedMirrorDrift(access, projectRead, repos) {
  // null for a container not provisioned yet: its labels stay out of the summary and read `skipped`.
  const rowsOf = repo => unlessUnprovisioned(repo.CONTAINER, () => repo.listAclRows(access));
  const userRows = await rowsOf(repos.users);
  const groupRows = await rowsOf(repos.groups);
  const inspectionRows = await rowsOf(repos.inspections);

  const projectOf = row => projectRead.get(String(row.projectId)) || null;
  const missing = (rows, parentReadOf) => rows.filter(row => !parentReadOf(row)).map(row => String(row.id));
  const section = (rows, parentReadOf, hasParent = () => true) => ({
    inDemi: rows.length,
    aclMismatch: storedAclMismatch(rows.filter(row => !hasParent(row) || parentReadOf(row)), parentReadOf),
    missingParent: missing(rows.filter(hasParent), parentReadOf)
  });

  const out = {};
  if (userRows) out.users = section(userRows, () => null, () => false);
  if (groupRows) out.groups = section(groupRows, projectOf);
  if (!inspectionRows) return out;

  const byId = new Map(inspectionRows.map(row => [String(row.id), row]));
  const ofKind = kind => inspectionRows.filter(row => row.kind === kind);
  out.inspections = section(ofKind('Inspection'),
    row => (row.projectId == null ? null : projectOf(row)), row => row.projectId != null);
  out.inspectionElements = section(ofKind('InspectionElement'),
    row => (byId.get(String(row.inspection)) || {}).read || null);
  out.inspectionItems = section(ofKind('InspectionItem'),
    row => (byId.get(String(row.element)) || {}).read || null);
  return out;
}

/** Every id set a diff produced, as one drift number. */
function driftOf(summary) {
  // A dead ENGAGE slug is in Eagle AND in DEMI, so every id-set diff reads it as clean — but it is
  // a link that 404s for every visitor, so the nightly alert has to see it. The ones that were
  // dropped are no longer drift; the ones only reported still are.
  const orphans = summary.engageOrphans
    ? summary.engageOrphans.dead.length - summary.engageOrphans.dropped.length
    : 0;
  const stored = STORED_LABELS.reduce((total, label) => {
    const s = summary[label];
    return s ? total + s.aclMismatch.length + s.missingParent.length : total;
  }, 0);
  return LABELS.reduce((total, label) => {
    const s = summary[label];
    if (!s) return total;
    // A misfiled row is drift the id-set diffs cannot see — present in both, stored under the
    // wrong parent — so it counts here or the alert stays quiet about it.
    return total + s.unpublishedOrDeleted.length + s.eagleOnly.length +
      (s.misfiledParent ? s.misfiledParent.length : 0) + (s.aclMismatch ? s.aclMismatch.length : 0);
  }, orphans + stored);
}

/**
 * The line a log alert matches. `drift=0 parentFieldsPending=0` is clean.
 *
 * A container the run did not sweep says `skipped` rather than zero — `comments` is behind
 * `--comments` and a zero there would read as "no drift" for a sweep that never happened.
 */
function summaryLine(summary) {
  const { projects: p, documents: d } = summary;
  const counts = (label) => {
    const s = summary[label];
    return s
      ? `${label}: unpublishedOrDeleted=${s.unpublishedOrDeleted.length} eagleOnly=${s.eagleOnly.length} ` +
        `aclMismatch=${(s.aclMismatch || []).length} `
      : `${label}: skipped `;
  };
  return '[reconcile] ' +
    `projects: unpublishedOrDeleted=${p.unpublishedOrDeleted.length} eagleOnly=${p.eagleOnly.length} ` +
    `aclMismatch=${(p.aclMismatch || []).length} ` +
    `documents: unpublishedOrDeleted=${d.unpublishedOrDeleted.length} eagleOnly=${d.eagleOnly.length} ` +
    `unresolvedParent=${d.unresolvedParent.length} aclMismatch=${(d.aclMismatch || []).length} ` +
    counts('commentPeriods') + counts('lists') + counts('notifications') + counts('updates') +
    STORED_LABELS.map(label => (summary[label]
      ? `${label}: aclMismatch=${summary[label].aclMismatch.length} ` +
        `missingParent=${summary[label].missingParent.length} `
      : `${label}: skipped `)).join('') +
    counts('comments') +
    // `skipped`, not zero, for the same reason `comments` says it: a sweep that never ran must not
    // read as a sweep that found nothing.
    (summary.engageOrphans
      ? `engageOrphans: dead=${summary.engageOrphans.dead.length} ` +
        `dropped=${summary.engageOrphans.dropped.length} ` +
        `unknown=${summary.engageOrphans.unknown.length} `
      : 'engageOrphans: skipped ') +
    `parentFieldsPending=${summary.parentFieldsPending} ` +
    `drift=${summary.drift}`;
}

/**
 * Every published id of one `/search` dataset.
 *
 * `fetchAllPages` throws on a short read, so an id missing here is an id Eagle does not publish
 * rather than one a truncated fetch did not reach.
 */
async function eagleIds(src, dataset, into = new Set(), onRow) {
  for (const row of await src.fetchAllPages(src.EAGLE_API_BASE, dataset)) {
    into.add(String(row._id));
    if (onRow) onRow(row);
  }
  return into;
}

/** Ids the stored report keeps per class; its counts stay whole. */
const STORED_IDS_PER_CLASS = 200;

/**
 * Every drifted id of one container, grouped by the parity-map class that explains it. A class
 * names a likely cause and nothing acts on it.
 *
 * @param {object} s  one container's section: the four id sets `diff` returns
 * @param {object} opts
 * @param {string|function} opts.dataset  Eagle _schemaName, or row -> it when the container mixes two
 * @param {function} opts.eagleRowOf   Eagle id -> the Eagle row (a CommentPeriod's carries `project`)
 * @param {function} [opts.eagleParent] Eagle id -> parentState; default null, a row with no parent
 * @param {function} [opts.demiParent]  DEMI row -> parentState; default null
 * @returns {Object<string, string[]>} class name -> ids
 */
function driftClasses(s, { dataset, eagleRowOf, eagleParent = () => null, demiParent = () => null }) {
  const datasetOf = typeof dataset === 'function' ? dataset : () => dataset;
  const out = {};
  const add = (ctx) => {
    const name = classify({ identity: 'anonymous', dataset: datasetOf(ctx.eagle || ctx.demi), ...ctx });
    (out[name] = out[name] || []).push(ctx.id);
  };
  const missing = [...s.eagleOnly, ...s.unresolvedParent].map(id => ({ id, eagle: eagleRowOf(id) }));
  const missingRows = missing.map(m => m.eagle);
  for (const { id, eagle } of missing) {
    add({ kind: 'missingInDemi', id, eagle, unpaired: s.unpublishedOrDeleted, parentState: eagleParent(id) });
  }
  for (const row of s.unpublishedOrDeleted) {
    add({ kind: 'extraInDemi', id: String(row.id), demi: row, unpaired: missingRows,
      parentState: demiParent(row) });
  }
  // Keyed by their Track id, which is what `demi-only` tells apart from an Eagle id.
  for (const row of s.trackOnly) {
    add({ kind: 'extraInDemi', id: String(row.id), demi: row, unpaired: missingRows, byEagleId: true,
      parentState: null });
  }
  return out;
}

/** The second log line: per container, how many drifted ids each class holds. */
function classesLine(summary) {
  const parts = Object.entries(summary.classes)
    .filter(([, classes]) => Object.keys(classes).length)
    .map(([label, classes]) => `${label}: ` +
      Object.keys(classes).sort().map(name => `${name}=${classes[name].length}`).join(' '));
  return `[reconcile] classes ${parts.join(' ') || 'none'}`;
}

/** The row `--store` writes: per container, every class's count and at most 200 of its ids. */
function storedReport(summary, ranAt) {
  const out = { ranAt };
  for (const [label, classes] of Object.entries(summary.classes)) {
    const section = { counts: {}, ids: {}, truncated: false };
    for (const [name, ids] of Object.entries(classes)) {
      section.counts[name] = ids.length;
      section.ids[name] = ids.slice(0, STORED_IDS_PER_CLASS);
      if (ids.length > STORED_IDS_PER_CLASS) section.truncated = true;
    }
    out[label] = section;
  }
  return out;
}

/**
 * @param {string[]} argv
 * @param {object} [deps] test seam: {sources, projects, documents, commentPeriods, comments,
 *   lists, notifications, updates}
 */
async function reconcile(argv = [], deps = {}) {
  const args = parseArgs(argv);
  const src = deps.sources || sources;
  const projectsRepo = deps.projects || projects;
  const documentsRepo = deps.documents || documents;
  const periodsRepo = deps.commentPeriods || commentPeriods;
  const commentsRepo = deps.comments || comments;
  const listsRepo = deps.lists || lists;
  const notificationsRepo = deps.notifications || notifications;
  const updatesRepo = deps.updates || updates;

  // systemAccess(), because a scoped context lists only what it can see: every row it cannot read
  // would compute as Eagle-only drift, and every unpublished row as gone from Eagle.
  const access = systemAccess();

  const summary = {
    eagle: src.EAGLE_API_BASE, projects: {}, documents: {}, drift: 0, failures: []
  };
  // Eagle id -> its `read[]`, across every dataset: Eagle ids are unique across its collections.
  const eagleRead = new Map();
  const noteRead = (row) => {
    if (Array.isArray(row.read) && row.read.length) eagleRead.set(String(row._id), row.read);
  };
  // Eagle id -> its row, for the drift classes. Every dataset but documents, which are too many to hold.
  const eagleRows = new Map();
  const keep = (row) => { noteRead(row); eagleRows.set(String(row._id), row); };
  const keepAs = dataset => row => keep({ ...row, _schemaName: dataset });

  // Eagle first: `fetchAllPages` throws when a fetch falls short of the reported
  // `searchResultsTotal`, so a truncated read can never be mistaken for a shrunken corpus.
  const eagleProjects = await src.fetchEagleProjects();
  const eagleProjectIds = new Set(eagleProjects.map(p => String(p._id)));
  eagleProjects.forEach(keep);
  // The registry seed-nosql builds. A Track row's dangling epic_guid resolves here exactly as it
  // does there, which is why this and not `eagleProjectIds` is the parent test: DEMI holds a
  // project row for such a guid, so a child under one is drift rather than unresolvable.
  const projectIndex = buildProjectIndex(
    buildRegistry(await src.loadTrackProjects(), eagleProjects).projects);
  // `admit` is the parent gate for BOTH children Eagle hangs off a `project` reference: a document
  // and a comment period. Either may name a `ProjectNotification` there.
  const { admit } = await documentAdmission(src, projectIndex);
  const eagleDocumentIds = new Set();
  const eagleDocumentProject = new Map(); // doc id -> its Eagle project id
  await src.streamEagleDocuments(page => {
    for (const doc of page) {
      const id = String(doc._id);
      eagleDocumentIds.add(id);
      eagleDocumentProject.set(id, doc.project != null ? String(doc.project) : null);
      noteRead(doc);
    }
  });

  const projectRows = await projectsRepo.listWithEagleId(access);
  const documentRows = await documentsRepo.listSeededIds(access);

  const truncated = async (pairs) => (await truncatedReads(access, pairs))
    .map(short => `${short} — the diff below is computed off a truncated read`);
  summary.failures = await truncated([
    ['projects', projectRows, projectsRepo.countWithEagleId],
    ['documents', documentRows, documentsRepo.countSeededIds]
  ]);

  const projectDiff = diff(projectRows, row => String(row.eagleId), eagleProjectIds,
    row => row.sourceSystem === 'eagle');
  const documentDiff = diff(documentRows, row => String(row.id), eagleDocumentIds, undefined,
    id => admit(eagleDocumentProject.get(id)) !== null);

  // The mirrors narrow a document or period to its DEMI project's ACL; a notification parent has
  // none, so a row under one keeps Eagle's own.
  const projectRead = new Map(projectRows.map(row => [String(row.id), row.read]));
  const projectReadOf = row => projectRead.get(String(row.projectId)) || null;

  summary.projects = { inDemi: projectRows.length, inEagle: eagleProjectIds.size, ...projectDiff,
    aclMismatch: aclMismatch(projectRows, row => String(row.eagleId), eagleRead) };
  summary.documents = { inDemi: documentRows.length, inEagle: eagleDocumentIds.size, ...documentDiff,
    aclMismatch: aclMismatch(documentRows, row => String(row.id), eagleRead, projectReadOf) };

  // The public-read containers, enumerated with the SAME predicates a request reads under, but
  // whole: a request's read stops at MAX_PAGE_SIZE rows, and every row past it would report as
  // Eagle-only drift. Their rows carry `id === eagleId`, and every one of them is the backfill's
  // or the push's, so there is no `pushOwned` split to make.
  //
  // Comment periods DO need a parent gate. eagle-api's `dataset=CommentPeriod` gates on the
  // period's own `read[]` and joins no parent (`api/aggregators/searchAggregator.js`), so a period
  // Eagle publishes under a project it does not publish is still in the id set — while the mirror
  // drops it, because its parent project row is not in DEMI. Measured on test 2026-09-07: 29 such
  // periods under 20 unpublished projects, every one of them reported as push drift.
  const notificationRows = await notificationsRepo.listEvery(access);
  const everyPeriodRow = [];
  // Every partition a period can live in: `commentPeriods` partitions on the parent, and the
  // mirror admits a project or a `ProjectNotification` — nothing else.
  const periodParents = [...projectRows, ...notificationRows];
  // The truncation guard's COUNT, one per partition read: a container-wide COUNT would also count
  // periods under parents this walk never visits.
  let periodCount = 0;
  for (const parent of periodParents) {
    for (const row of await periodsRepo.listEveryByProject(parent.id, access)) everyPeriodRow.push(row);
    periodCount += await periodsRepo.countByProject(parent.id, access);
  }
  // ENGAGE owns these rows and Eagle holds only the copy DEMI sent it, so neither the id diff nor
  // `--drop-orphans` may act on them; reconcile-engage.js checks them instead.
  const engageOwned = row => row.sourceSystem === 'engage';
  const periodRows = everyPeriodRow.filter(row => !engageOwned(row));
  const engagePeriodRows = everyPeriodRow.filter(engageOwned);
  const listRows = [
    ...await listsRepo.listEveryOfKind(listsRepo.KINDS.LIST, access),
    ...await listsRepo.listEveryOfKind(listsRepo.KINDS.ORGANIZATION, access)
  ];
  const updateRows = await updatesRepo.listEvery(access);

  // One `lists` container holds both kinds, so both id sets are one comparison.
  const eagleListIds = await eagleIds(src, 'Organization',
    await eagleIds(src, 'List', new Set(), keepAs('List')), keepAs('Organization'));
  // The period's own parent ref rides along: it is the only thing that says whether the mirror
  // could have resolved a parent for it.
  const eaglePeriodProject = new Map(); // period id -> its Eagle parent ref
  const eaglePeriodIds = await eagleIds(src, 'CommentPeriod', new Set(), row => {
    eaglePeriodProject.set(String(row._id), row.project != null ? String(row.project) : null);
    keep(row);
  });
  // The Eagle copy of an ENGAGE row is stored under a DEMI id, so it would read as eagleOnly.
  for (const row of engagePeriodRows) if (row.eagleId) eaglePeriodIds.delete(String(row.eagleId));
  const eagleNotificationIds = await eagleIds(src, 'ProjectNotification', new Set(), keep);
  const eagleUpdateIds = await eagleIds(src, 'RecentActivity', new Set(), keep);

  // Rows that ARE mirrored, under a parent the admission rule would not choose. Nothing above sees
  // these: they are in both Eagle and DEMI, so every id-set diff reads them as clean. They are the
  // shape the project-first rule wrote — a period whose Eagle ref names a `ProjectNotification`
  // filed in a Track project's partition, under that project's ACL, with its comments cascaded to
  // the same level. Periods only: `listSeededIds` carries no partition for the documents.
  const misfiledPeriods = periodRows
    .filter(row => {
      const parent = admit(eaglePeriodProject.get(String(row.id)));
      return parent !== null && String(row.projectId) !== parent;
    })
    .map(row => String(row.id));

  summary.commentPeriods = {
    inDemi: periodRows.length, inEagle: eaglePeriodIds.size,
    ...diff(periodRows, row => String(row.id), eaglePeriodIds, undefined,
      id => admit(eaglePeriodProject.get(id)) !== null),
    misfiledParent: misfiledPeriods,
    aclMismatch: aclMismatch(periodRows, row => String(row.id), eagleRead, projectReadOf),
    engageOwned: engagePeriodRows.length
  };

  // OPT-IN, like `--comments`, and for the same reason: one ENGAGE round trip per `isMet` period.
  // Absent `ENGAGE_API_BASE` it does not run at all — see the constant.
  if (args.engage) {
    const base = deps.engageApiBase !== undefined ? deps.engageApiBase : ENGAGE_API_BASE;
    if (!base) {
      summary.failures.push('ENGAGE_API_BASE is unset — the dead-slug sweep did not run');
    } else {
      summary.engageOrphans = await engageOrphans(periodRows,
        { base, drop: args.dropOrphans, periodsRepo, deps });
      summary.failures.push(...summary.engageOrphans.failures);
    }
  }
  summary.lists = {
    inDemi: listRows.length, inEagle: eagleListIds.size,
    ...diff(listRows, row => String(row.id), eagleListIds),
    aclMismatch: aclMismatch(listRows, row => String(row.id), eagleRead)
  };
  summary.notifications = {
    inDemi: notificationRows.length, inEagle: eagleNotificationIds.size,
    ...diff(notificationRows, row => String(row.id), eagleNotificationIds),
    aclMismatch: aclMismatch(notificationRows, row => String(row.id), eagleRead)
  };
  // An Update's parent is keyed by EAGLE id, and a notification wins an id a Track project carries.
  const updateParentRead = new Map(projectRows.map(row => [String(row.eagleId), row.read]));
  for (const row of notificationRows) updateParentRead.set(String(row.id), row.read);
  summary.updates = {
    inDemi: updateRows.length, inEagle: eagleUpdateIds.size,
    ...diff(updateRows, row => String(row.id), eagleUpdateIds),
    aclMismatch: aclMismatch(updateRows, row => String(row.id), eagleRead,
      row => updateParentRead.get(String(row.projectId)) || null, updateRead)
  };

  Object.assign(summary, await storedMirrorDrift(access, projectRead, {
    users: deps.users || users, groups: deps.groups || groups, inspections: deps.inspections || inspections
  }));

  summary.failures.push(...await truncated([
    ['lists', listRows, async (a) =>
      (await listsRepo.countByKind(listsRepo.KINDS.LIST, a)) +
      (await listsRepo.countByKind(listsRepo.KINDS.ORGANIZATION, a))],
    ['notifications', notificationRows, notificationsRepo.count],
    ['updates', updateRows, updatesRepo.count],
    ['commentPeriods', everyPeriodRow, async () => periodCount]
  ]));

  // The parent a drifted child names, as the push would find it (states: parity-map `classify`).
  const demiParentIds = new Set(periodParents.map(row => String(row.id)));
  const demiEagleIds = new Set(periodParents.map(row => String(row.eagleId || row.id)));
  const parentOfRef = (ref) => {
    const id = eagleRef(ref);
    if (!id) return 'missing-in-eagle';
    const parent = admit(id);
    if (parent !== null) return demiParentIds.has(parent) ? 'in-demi' : 'missing-in-demi';
    return demiEagleIds.has(id) ? 'not-public' : 'missing-in-eagle';
  };
  const demiParentOf = row => (demiParentIds.has(String(row.projectId)) ? 'in-demi' : 'missing-in-eagle');
  const eagleRowOf = id => eagleRows.get(id);
  const child = (dataset, parentRefOf, demiParent = demiParentOf) => ({
    dataset, eagleRowOf: id => eagleRows.get(id) || { _id: id, project: parentRefOf(id) },
    eagleParent: id => parentOfRef(parentRefOf(id)), demiParent
  });
  summary.classes = {
    projects: driftClasses(summary.projects, { dataset: 'Project', eagleRowOf }),
    documents: driftClasses(summary.documents, child('Document', id => eagleDocumentProject.get(id))),
    commentPeriods: driftClasses(summary.commentPeriods,
      child('CommentPeriod', id => eaglePeriodProject.get(id))),
    lists: driftClasses(summary.lists, { dataset: row => row.kind || row._schemaName, eagleRowOf }),
    notifications: driftClasses(summary.notifications, { dataset: 'ProjectNotification', eagleRowOf }),
    // An Update's DEMI `projectId` is its parent's Eagle id, so both sides resolve the same way.
    updates: driftClasses(summary.updates, child('RecentActivity', id => (eagleRows.get(id) || {}).project,
      row => parentOfRef(row.projectId)))
  };

  // Comments are OPT-IN: the sweep costs one eagle-api round trip per comment period and two
  // single-partition Cosmos queries (read, COUNT) per period — too much for the nightly timer.
  if (args.comments) {
    const commentRows = [];
    const eagleCommentIds = new Set();
    // Comments under a period the mirror could not resolve. Walking DEMI's periods alone never
    // fetched them, so they were neither drift nor reported — a silent hole the size of the
    // unresolved-period set. They cost one round trip each, on a flag that is already opt-in.
    const unresolvedComments = new Map(); // comment id -> its period id
    for (const periodId of summary.commentPeriods.unresolvedParent) {
      await eachCommentPage(periodId, { sources: src }, (items) => {
        for (const row of items) {
          eagleCommentIds.add(String(row._id));
          unresolvedComments.set(String(row._id), periodId);
          noteRead(row);
        }
      });
    }
    // A comment is narrowed to its period's ACL, as the comment mirror does.
    const periodReadOf = new Map();
    let commentCount = 0;
    for (const period of periodRows) {
      for (const row of await commentsRepo.listEveryByPeriod(period.id, access)) {
        commentRows.push(row);
        periodReadOf.set(String(row.id), period.read);
      }
      commentCount += await commentsRepo.countByPeriod(period.id, access);
      await eachCommentPage(period.id, { sources: src }, (items) => {
        for (const row of items) {
          eagleCommentIds.add(String(row._id));
          noteRead(row);
        }
      });
    }
    summary.comments = {
      inDemi: commentRows.length, inEagle: eagleCommentIds.size,
      ...diff(commentRows, row => String(row.id), eagleCommentIds, undefined,
        id => !unresolvedComments.has(id)),
      aclMismatch: aclMismatch(commentRows, row => String(row.id), eagleRead,
        row => periodReadOf.get(String(row.id)) || null)
    };
    summary.failures.push(...await truncated([['comments', commentRows, async () => commentCount]]));
    // Every other comment was read under a period DEMI holds; an unresolved one's period is not
    // mirrored, for the reason its own project ref gives.
    summary.classes.comments = driftClasses(summary.comments, {
      dataset: 'Comment', eagleRowOf: id => ({ _id: id }), demiParent: () => 'in-demi',
      eagleParent: id => (unresolvedComments.has(id)
        ? parentOfRef(eaglePeriodProject.get(unresolvedComments.get(id))) : 'in-demi')
    });
  }

  summary.drift = driftOf(summary);
  // Not push drift, so not folded into `drift`: these are documents whose CHUNKS never got their
  // parent fields re-stamped (`controllers/nosql/document.js`, markParentFieldsPending). Reported
  // on the same line because this run is the only thing that looks at the corpus nightly, and the
  // repair is `backfill-chunk-parent-fields.js --live --pending`, which clears the flag on every
  // document it verifies — as does `--live --project <id>`, the poison-queue repair.
  summary.parentFieldsPending = await documentsRepo.countParentFieldsPending(access);

  return summary;
}

function report(summary, { json } = {}) {
  const lines = [`[reconcile] eagle=${summary.eagle}`];
  for (const label of LABELS) {
    const s = summary[label];
    // `comments` is only there when the run swept it — see `--comments`.
    if (!s) continue;
    // Capped: a real drift can carry thousands of ids and --json is where the full set lives.
    const preview = ids => ids.slice(0, 20).join(', ') + (ids.length > 20 ? ', …' : '');
    const line = (text, ids) =>
      lines.push(`  ${text}: ${ids.length}${ids.length ? ` — ${preview(ids)}` : ''}`);

    lines.push(`${label}: ${s.inDemi} mirrored in DEMI, ${s.inEagle} published in Eagle`);
    if (s.engageOwned) {
      lines.push(`  engageOwned (ENGAGE-owned, left out of this diff and never dropped): ${s.engageOwned}`);
    }
    // NOT a delete list. eagle-api's `/api/public/{document,project}/{id}` answers `200 []` for a
    // deleted row AND for one that merely lost `public` from its `read[]` — both are what
    // `runDataQuery(..., ['public'], ...)` returns when nothing matches — so an anonymous caller
    // cannot tell an unpublished row from a hard-deleted one. Purging on this set would destroy
    // an unpublished row, its chunks and its index entries.
    // ponytail: report-only until eagle-api offers a tombstone or DEMI holds a credential that
    // can read unpublished rows; then this set can be probed one id at a time and purged.
    line('unpublishedOrDeleted (gone from Eagle\'s public search, NOT purged)',
      s.unpublishedOrDeleted.map(r => r.id));
    line('eagleOnly (the push missed these)', s.eagleOnly);
    // The system read excludes every level-0 row, so a sealed row can only surface here.
    if (s.eagleOnly.length) {
      lines.push('    rows stored at level 0 are not read here and count as missing; a re-push repairs ' +
        'those an Eagle push sealed, a DEMI seal (sealedAt) stays');
    }
    if (s.unresolvedParent.length) {
      line('unresolvedParent (Eagle-only, but its own project is unpublished/gone — seed-nosql ' +
        'drops these too, not counted as drift)', s.unresolvedParent);
    }
    if (s.misfiledParent && s.misfiledParent.length) {
      line('misfiledParent (mirrored, but stored under a parent the admission rule would not ' +
        'choose — re-mirror to move them)', s.misfiledParent);
    }
    if (s.aclMismatch && s.aclMismatch.length) {
      line('aclMismatch (in both, but DEMI read[] lets in different callers than the read[] the ' +
        'mirror would write from Eagle\'s, or isPublished disagrees with read[]; check each row, ' +
        'a full re-push would overwrite DEMI-side changes)', s.aclMismatch);
    }
    if (s.trackOnly.length) {
      lines.push(`  ${s.trackOnly.length} Track-sourced project(s) are also gone from Eagle's ` +
        'public search — that is close-unpublished-track-projects.js, not the push');
    }
  }
  for (const label of STORED_LABELS) {
    const s = summary[label];
    if (!s) continue;
    lines.push(`${label}: ${s.inDemi} mirrored in DEMI (checked against the stored Eagle copy, ` +
      'no Eagle id set: eagle-api does not publish this kind)');
    for (const [text, ids] of [
      ['aclMismatch (read[] is not what the mirror would write from its own Eagle read and parent)', s.aclMismatch],
      ['missingParent (the parent row it is capped by is not in DEMI)', s.missingParent]
    ]) {
      if (ids.length) lines.push(`  ${text}: ${ids.length} — ${ids.slice(0, 20).join(', ')}${ids.length > 20 ? ', …' : ''}`);
    }
  }
  const orphans = summary.engageOrphans;
  if (orphans) {
    const preview = ids => ids.slice(0, 20).join(', ') + (ids.length > 20 ? ', …' : '');
    lines.push(`engageOrphans: ${orphans.checked} isMet period(s) resolved against ENGAGE`);
    lines.push(`  dead (ENGAGE no longer holds the slug)${orphans.dropped.length ? '' : ', NOT dropped'}: ` +
      `${orphans.dead.length}${orphans.dead.length ? ` — ${preview(orphans.dead)}` : ''}`);
    if (orphans.dropped.length) {
      lines.push(`  dropped from the mirror: ${orphans.dropped.length} — ${preview(orphans.dropped)}`);
    }
    if (orphans.unknown.length) {
      // NEVER a delete list. These are the periods ENGAGE did not answer for — an unreachable host,
      // a 401, a metURL with no slug in it — and "could not check" is not "gone".
      lines.push(`  unknown (ENGAGE gave no usable answer, left alone): ${orphans.unknown.length} — ` +
        preview(orphans.unknown));
      // A slow ENGAGE and an unreachable one both land here, but not for the same reason — count
      // them apart so the alert says which one to go chase.
      const reasons = Object.values(orphans.unknownReasons || {});
      if (reasons.length) {
        const counts = reasons.reduce((acc, r) => acc.set(r, (acc.get(r) || 0) + 1), new Map());
        lines.push('    reason: ' +
          [...counts].map(([reason, n]) => `${reason}=${n}`).join(', '));
      }
    }
  }
  for (const f of summary.failures) lines.push(`  ✗ ${f}`);
  if (json) {
    const ids = s => ({
      unpublishedOrDeleted: s.unpublishedOrDeleted.map(r => r.id), eagleOnly: s.eagleOnly,
      unresolvedParent: s.unresolvedParent, aclMismatch: s.aclMismatch || []
    });
    const full = {};
    for (const label of LABELS) if (summary[label]) full[label] = ids(summary[label]);
    lines.push(JSON.stringify(full, null, 2));
  }
  return lines.join('\n');
}

/**
 * One run, logging exactly what the CLI logs — the nightly schedule and the CLI must not be able
 * to produce different output, because the log alert matches only one of its lines.
 *
 * `--drop-orphans` is the only mode that writes, and the nightly timer never passes it: a scheduled
 * job that deletes rows off a third party's answer is not something an alert can undo.
 *
 * @param {object} [opts] {json} full id sets, {comments} sweep the comment container too (one
 *   eagle-api round trip per comment period), {engage} resolve every `isMet` period's slug,
 *   {dropOrphans} delete the ones ENGAGE no longer holds, {store} upsert the class report for
 *   GET /admin/reconcile, {deps} the test seam `reconcile` takes, plus `cache`
 */
async function run({ json = false, comments: sweepComments = false, engage = false,
  dropOrphans = false, store = false, deps } = {}) {
  const ranAt = new Date().toISOString();
  const argv = [
    ...(sweepComments ? ['--comments'] : []),
    ...(dropOrphans ? ['--drop-orphans'] : engage ? ['--engage'] : [])
  ];
  const summary = await reconcile(argv, deps);
  logger.info(report(summary, { json }));
  // Its own record, so a log alert matches this line and not the report body around it.
  logger.info(summaryLine(summary));
  logger.info(classesLine(summary));
  if (store) {
    // Logged, not thrown: the drift line is already out, and the timer reads a throw as a failed run.
    try {
      await ((deps && deps.cache) || cache).put(cache.RECONCILE_REPORT_ID,
        { body: storedReport(summary, ranAt) });
    } catch (err) {
      logger.error('[reconcile] report store failed', { error: err.message, stack: err.stack });
    }
  }
  return summary;
}

module.exports = {
  parseArgs, diff, aclMismatch, summaryLine, classesLine, reconcile, report, run,
  // Exported for the tests: the slug parse and the three-way ENGAGE answer are where a wrong call
  // turns into a deleted row, so both are asserted directly as well as through `reconcile`.
  slugOf, slugState, engageOrphans
};

if (require.main === module) {
  const { initCosmosClient } = require('../db/cosmos-nosql');

  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    logger.error(err.message);
    process.exit(1);
  }
  initCosmosClient();

  run({ json: args.json, comments: args.comments, engage: args.engage,
    dropOrphans: args.dropOrphans, store: args.store })
    .catch(err => {
      logger.error(`[reconcile] ${err.stack || err.message}`);
      process.exit(1);
    });
}
