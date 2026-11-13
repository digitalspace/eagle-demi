'use strict';

/**
 * DEMI project records kept in step with Track's list. Stored `read`, `isPublished`, `vis` carry
 * over, since a re-merge would undo a hand-set level; a record Track omits is never deleted.
 */

const { isDeepStrictEqual } = require('node:util');
const { readForLevel, systemAccess, capRead } = require('../helpers/access-sql');
const {
  ensureProjectShortLink, needsSlugMigration, isWrongHostDefault, releaseCreatedCode, repointProjectLinks
} = require('../helpers/short-links');
const { writeGuarded } = require('../helpers/etag-write');
const {
  TRACK_PRECEDENCE, mergeTrackProject, carryDemiOnlyFields, carryDelete, holdStaffEdits, isDemiOwnedProject,
  isNativeProject, eagleOnlyProjectId, hasValue
} = require('../merge/project');
const { isStalePush, stampPush } = require('../controllers/nosql/eagle-mirror');
const { deriveAssessments } = require('../merge/assessments');
const { deriveInputs } = require('../domain/works-derive');
const { syncWorkDocs } = require('./sync-works');
const { SYNC_STATE_FIELDS } = require('../ownership/sync-out');
const { TWIN_CARRY_FIELDS, DEMI_OWNED_AT, TRACK_PUSHED_AT, STAFF_ROLE_FIELDS } = require('../ownership/project');
const { trackApiToExtract } = require('../seed/sources');
const linksRepository = require('../repositories/links');
const { logger } = require('../utils/logger');

const TRACK_FIELDS = TRACK_PRECEDENCE.map(([target]) => target);

/** Wrong-host link records moved per run, so a bad `LINK_BASE_URL` cannot rewrite every link in one night. */
const HEAL_CAP = 500;

/**
 * Track-owned fields the feed disagrees with. Undefined in the merge is left alone, so an emptied
 * upstream column cannot blank a row; arrays share one mapper, so a serialised compare holds.
 */
const TRACK_ARRAY_FIELDS = ['phases', 'works', 'legislationTransitions'];

/** `changes` to write, and the `held` fields staff saved that the feed disagrees with, left as stored. */
function trackChanges(existing, merged) {
  const changes = feedChanges(existing, holdStaffEdits({ ...merged }, existing));
  const held = Object.keys(feedChanges(existing, merged)).filter(field => !(field in changes));
  return { changes, held };
}

// A push stores `[]` for none and an Eagle push drops it, so absent and empty are the same list.
const sameList = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);

function feedChanges(existing, merged) {
  const moved = (field) => (TRACK_ARRAY_FIELDS.includes(field)
    ? merged[field] && !sameList(merged[field], existing[field])
    : merged[field] !== undefined && merged[field] !== existing[field]);
  return Object.fromEntries([...TRACK_FIELDS, ...TRACK_ARRAY_FIELDS].filter(moved).map(field => [field, merged[field]]));
}

const eagleOf = (row) => (row.sources || {}).eagle || null;

/** `row` with `assessments`, `phaseIds` and `activeWork` derived again, keeping names off `stored`'s. */
const withDerived = (row, stored, inputs = {}) =>
  Object.assign(row, deriveAssessments(row, { previous: stored && stored.assessments, ...inputs }));

const DRIFT_FIELDS = ['assessments', 'phaseIds', 'activeWork', 'legislationTransitions', 'works'];
/** The works derive other values than stored while Track moved nothing else. Never with WORKS_READ off. */
const drifted = (inputs, changes, row, stored) => Boolean(inputs.worksForDerive) &&
  Object.keys(changes).every(field => DRIFT_FIELDS.includes(field)) &&
  DRIFT_FIELDS.some(field => JSON.stringify(row[field] ?? null) !== JSON.stringify(stored[field] ?? null));

/** The staff lists on the twin that differ from {carried}'s copy: saved or cleared after the carry. */
const changedLists = (twin, carried = {}) => STAFF_ROLE_FIELDS.filter(k =>
  !isDeepStrictEqual(twin[k], carried[k]) && (hasValue(twin[k]) || hasValue(carried[k])));

/** The twin disowned; with {trackId}, stamped `foldedInto` without its staff lists unless one differs from {carried}'s. */
function settleTwin(twin, trackId, carried) {
  const owned = isDemiOwnedProject(twin);
  const fold = trackId !== undefined && changedLists(twin, carried).length === 0;
  const drop = (k) => (owned && (k === DEMI_OWNED_AT || SYNC_STATE_FIELDS.includes(k))) || (fold && STAFF_ROLE_FIELDS.includes(k));
  const row = Object.fromEntries(Object.entries(twin).filter(([k]) => !drop(k)));
  return fold ? { ...row, foldedInto: String(trackId) } : row;
}

/** `{row, twin, clash}`: {trackRow} with the twin's DEMI fields and staff saves at the stricter level, the settled twin,
 * and the fields both hold with different values, which a fold must not pick. */
function foldTwin(trackRow, twin, derive = {}) {
  const fields = TWIN_CARRY_FIELDS.filter(field => hasValue(twin[field]));
  const clash = fields.filter(field => hasValue(trackRow[field]) && !isDeepStrictEqual(trackRow[field], twin[field]));
  // An owned twin's Eagle side and delete state are DEMI's: its Eagle copy must not replace them.
  const row = isDemiOwnedProject(twin)
    ? carryDelete(carryDemiOnlyFields({ ...trackRow }, twin, fields, derive), twin)
    : withDerived(holdStaffEdits({ ...trackRow, ...structuredClone(Object.fromEntries(fields.map(f => [f, twin[f]]))) },
      twin), twin, derive);
  row.read = capRead(capRead(row.read, trackRow.read), twin.read);
  row.isPublished = row.read.includes('public');
  return { row, twin: settleTwin(twin, trackRow.id, row), clash };
}

const unfolded = 'still owned or holding staff lists beside its Track row; fold-twins settles it';
// A twin folded into another Track project is that project's: relinking would move it.
const ownTwin = (twin, id) => (!twin || [undefined, id].includes(twin.foldedInto) ? twin : null);
const foldedElsewhere = (id, twinId) => {
  logger.warn('[track-projects] Eagle twin folded into another Track project, not relinked', { id, twinId });
  return { action: 'skipped', reason: 'foldedElsewhere' };
};

/** A row with a public page and no code yet, or still on a pre-slug random one. */
const owesLink = (row) => Boolean(row.eagleId) && (!row.shortCode || needsSlugMigration(row));

/**
 * The links repository for a dry run: reads go through, writes stay in memory, so the mint and
 * the heal run the live code and report what a live run would change.
 */
function dryLinks(links) {
  const made = new Map();
  return {
    getById: async (code) => made.get(code) || links.getById(code),
    create: async (record) => {
      if (made.has(record.id) || await links.getById(record.id)) throw Object.assign(new Error('Conflict'), { code: 409 });
      made.set(record.id, record);
      return record;
    },
    repoint: async (code, url) => {
      const record = made.get(code) || await links.getById(code);
      if (record) made.set(code, { ...record, url, updatedAt: new Date().toISOString() });
      return record ? made.get(code) : null;
    }
  };
}

/**
 * The per-row writer a run and a push share. `lookup` finds the stored rows a Track row is matched
 * against: run-start maps for a run, point reads for a push. {skipLinkUpkeep} skips heal and migration.
 */
function rowWriter({ repo, links, live, now, skipLinkUpkeep, summary, lookup, onRelink = () => {}, push = false }) {
  const linkRepos = { links: live ? links : dryLinks(links), projects: repo };
  const reread = (id) => () => repo.getById(systemAccess(), id);
  const lost = (id) => (_current, attempt) =>
    logger.warn('[track-projects] project write lost its etag race, rebuilding', { id, attempt });

  /** Mints on `project` and says whether its code moved. */
  const mint = async (project, claim = null) => {
    const before = project.shortCode;
    await ensureProjectShortLink(project, linkRepos, claim);
    return project.shortCode !== before;
  };

  /**
   * `writeGuarded` whose `build(current, mint)` may mint. A slug minted by a try that lost is
   * released before the retry: the row that won (say a staff-pinned code) may not want it.
   */
  const writeMinting = async (id, existing, build) => {
    const claim = {};
    const written = await writeGuarded({
      existing,
      reread: reread(id),
      attempt: async (current) => {
        await releaseCreatedCode(claim, linkRepos);
        return build(current, (row) => mint(row, claim));
      },
      onLost: lost(id)
    });
    if (written.status !== 'saved') await releaseCreatedCode(claim, linkRepos);
    if (written.minted) summary.shortLinks++;
    return written;
  };

  let healBudget = HEAL_CAP;
  let healLeftOver = false;
  /**
   * Moves the project's records still on another host's `/p/<eagleId>` onto `LINK_BASE_URL`. The
   * row is read again before a record moves: a target staff set since the run started wins.
   */
  const heal = async (project) => {
    if (skipLinkUpkeep || !project.eagleId || project.shortLinkUrl) return;
    let fresh;
    let reserved = 0;
    try {
      const { repointed } = await repointProjectLinks(project, linkRepos, {
        only: async (record) => {
          if (!isWrongHostDefault(project, record.url)) return false;
          if (fresh === undefined) fresh = await repo.getById(systemAccess(), project.id);
          if (!fresh || !isWrongHostDefault(fresh, record.url)) return false;
          if (reserved >= healBudget) {
            healLeftOver = true;
            return false;
          }
          reserved++;
          return true;
        }
      });
      healBudget -= repointed.length;
      summary.healed += repointed.length;
    } catch (err) {
      summary.failures++;
      logger.error(`[track-projects] project ${project.id} link heal failed`, { error: err.message, stack: err.stack });
    }
  };

  /**
   * Inserts a row this run read as absent. One created behind the run is the next run's.
   * `build` runs per live try, so a row built off another stored row sees that row as it stands.
   */
  const insert = async (id, build) => {
    if (!live) return mint(await build()).then((minted) => { if (minted) summary.shortLinks++; });
    const written = await writeMinting(id, null, async (current, mintRow) => {
      if (current) return { status: 'exists' };
      // A copy per try: a lost try's code is released before this one, so it must not ride along.
      const fresh = { ...(await build()) };
      const minted = await mintRow(fresh);
      await repo.upsert(fresh, { create: true });
      return { status: 'saved', minted };
    });
    if (written.status === 'exists') logger.warn('[track-projects] project created behind this run, left for the next', { id });
    return written.status;
  };

  /** Disown the twin, folded into {trackId} when given, or sync-out sends it and the Track row to one Eagle project. */
  const disownTwin = async (twinId, trackId, carried) => {
    const written = await writeGuarded({
      existing: await repo.getById(systemAccess(), twinId),
      reread: reread(twinId),
      attempt: async (twin) => {
        const row = twin && settleTwin(twin, trackId, carried);
        const kept = twin && trackId !== undefined ? changedLists(twin, carried) : [];
        if (!row || isDeepStrictEqual(row, twin)) return { status: 'none', kept };
        await repo.upsert(row, { etag: twin._etag });
        return { status: 'saved', kept };
      },
      onLost: lost(twinId)
    });
    if (written.status === 'conflict' || written.kept?.length) {
      summary.failures++;
      logger.error(`[track-projects] project ${twinId} ${unfolded}`, { status: written.status, lists: (written.kept || []).join(',') });
    }
    return written.status;
  };

  /** A push that leaves the twin owned fails, so Track and the alert see it; a run logs it and goes on. */
  const disownFailure = async (twinId, trackId, carried) => {
    if (!push) return disownTwin(twinId, trackId, carried).then(() => null);
    try {
      if (await disownTwin(twinId, trackId, carried) !== 'conflict') return null;
    } catch (err) {
      logger.error(`[track-push] twin not disowned id=${twinId}, ${unfolded}`, { error: err.message, stack: err.stack });
    }
    return { action: 'failed', status: 'twinConflict' };
  };

  // Without link upkeep a stored row is written only when Track moved it; the migration-only write is the night's.
  const owes = (row) => !skipLinkUpkeep && owesLink(row);
  // A run compares against its start time but never stamps: that time is DEMI's clock, not a Track commit.
  const stamp = (row, pushedAt, current) => stampPush(row, push ? pushedAt : undefined, current, TRACK_PUSHED_AT);

  /**
   * One `GET /api/v1/projects` row; {pushedAt} is a push's epoch ms or the run's start; {nested} Track's nested
   * works. Resolves `{action}`: created, relinked, updated, unchanged, stale, skipped with `reason`, or failed.
   */
  const write = async (apiProject, { phases, works, nested, pushedAt = null } = {}) => {
    const track = trackApiToExtract(apiProject);
    const id = String(track.track_project_id);
    const existing = await lookup.stored(id);
    const guid = track.epic_guid ? String(track.epic_guid) : null;
    const unmatched = !existing && guid;
    const twinRow = unmatched ? await lookup.eagleOnly(guid) : null;
    const relink = ownTwin(twinRow, id);
    const mergeOpts = { now, phases, works };
    // Before the row, so its derived values read the documents this run wrote.
    const writeDocs = async () => {
      const { stale: staleDocs, adopted, failed } = await syncWorkDocs(id, nested, { pushedAt, live, now });
      Object.assign(summary, { stale: summary.stale + staleDocs, adopted: summary.adopted + adopted,
        failures: summary.failures + failed });
    };
    const inputs = () => deriveInputs({ id, sources: { track } });
    /** The row Track and the works give for `current`, whether only its derived values drifted, else whether Track moved it. */
    const rebuild = async (current) => {
      const derive = await inputs();
      const { changes, held } = trackChanges(current, mergeTrackProject(track, eagleOf(current), { ...mergeOpts, ...derive }));
      const row = withDerived(stamp({ ...current, ...changes, sources: { ...current.sources, track } }, pushedAt, current),
        current, derive);
      const drift = drifted(derive, changes, row, current);
      const moved = Object.keys(changes).length > 0 && !drift;
      return { changes, held, row, drift, moved, rewrite: moved || drift };
    };
    const countLists = () => { if (phases) summary.phases++; if (works) summary.works++; };
    const landed = (inserted) => !live || inserted === 'saved';
    const stale = () => { summary.stale++; return { action: 'stale' }; };

    if (relink) {
      // A re-key, not a new record: it keeps the level and stamps; the folded twin stays until the seed's `--reconcile`.
      onRelink(relink);
      await heal(relink);
      await writeDocs();
      // The twin as stored now, not at run start: a tags PUT or a narrowing since must carry.
      let twin;
      const inserted = await insert(id, async () => {
        twin = (live && await repo.getById(systemAccess(), relink.id)) || relink;
        const derive = await inputs();
        const merged = mergeTrackProject(track, eagleOf(twin), { ...mergeOpts, ...derive });
        // The Track row is a new record: it must not inherit the twin's sync-out state.
        const carried = Object.fromEntries(Object.entries(twin)
          .filter(([k]) => !SYNC_STATE_FIELDS.includes(k) && k !== 'foldedInto'));
        return foldTwin(stamp({ ...carried, ...merged, read: twin.read }, pushedAt, null), twin, derive).row;
      });
      if (inserted === 'conflict') return { action: 'failed', status: 'conflict' };
      if (inserted === 'exists') return { action: 'skipped', reason: 'createdBehind' };
      if (landed(inserted)) { summary.relinked++; countLists(); }
      const failure = inserted === 'saved' && await disownFailure(relink.id, id, twin);
      return failure ? { ...failure, written: true } : { action: 'relinked' };
    }

    // A new row beside a twin folded into another Track project would share its Eagle id.
    if (twinRow !== relink) return foldedElsewhere(id, twinRow.id);
    const native = unmatched ? await lookup.native(guid) : null;
    if (native) {
      summary.nativeClash++;
      return { action: 'skipped', reason: 'nativeClash', nativeId: String(native.id), eagleId: guid };
    }

    if (!existing) {
      await writeDocs();
      const inserted = await insert(id, async () => {
        const derive = await inputs();
        const merged = stamp(mergeTrackProject(track, null, { ...mergeOpts, ...derive }), pushedAt, null);
        // Admission is level 1: the merge's default for an unmatched Track project is level 2,
        // and no job may widen anything.
        merged.read = readForLevel(1);
        merged.isPublished = false;
        return withDerived(merged, null, derive);
      });
      if (inserted === 'conflict') return { action: 'failed', status: 'conflict' };
      if (inserted === 'exists') return { action: 'skipped', reason: 'createdBehind' };
      if (landed(inserted)) { summary.created++; countLists(); }
      return { action: 'created' };
    }

    // Skip API rows (`sources: {}`): stamping `sources.track` would pass them off as Track rows.
    if (!(existing.sources || {}).track) {
      summary.skippedApiRows++;
      return { action: 'skipped', reason: 'apiRow' };
    }
    await heal(existing);
    // A retry repairs a relink whose first try left the twin owned; its staff lists wait for fold-twins.
    const twinOwed = push && guid ? await disownFailure(eagleOnlyProjectId(guid)) : null;
    if (twinOwed) return twinOwed;
    await writeDocs();
    if (isStalePush(pushedAt, existing, TRACK_PUSHED_AT)) return stale();
    if (push && existing.isDeleted === true) logger.warn(`[track-push] push on a deleted row id=${id}`);

    const { changes: found, held, drift, moved: changed, rewrite } = await rebuild(existing);
    const stateMove = 'projectState' in found
      ? `${JSON.stringify(existing.projectState ?? null)} -> ${JSON.stringify(found.projectState)}`
      : null;
    const result = { held, stateMove };
    const tally = (drifted) => {
      countLists();
      if (held.length) summary.held++;
      if (stateMove) summary.stateMoved++;
      if (drifted) summary.derivedDrift++;
    };
    // A row owing a slug code is written even when Track says nothing new; the migration stamps
    // `shortCodeSource`, so the next night skips it.
    if (!rewrite && !owes(existing)) {
      tally();
      return { action: 'unchanged', ...result };
    }
    if (!live) {
      tally(drift);
      if (changed) summary.updated++;
      // A migration with no free slug keeps its code, so only a real move counts.
      if (owesLink(existing) && await mint({ ...existing })) summary.shortLinks++;
      return { action: rewrite ? 'updated' : 'unchanged', ...result };
    }

    // Rebuilt off the row that stored, guarded on its revision: a whole-item write from the
    // run-start snapshot would undo a staff code set while the run was going.
    const written = await writeMinting(id, existing, async (current, mintRow) => {
      if (!current) return { status: 'missing' };
      if (isStalePush(pushedAt, current, TRACK_PUSHED_AT)) return { status: 'stale' };
      const { row, drift: repaired, moved } = await rebuild(current);
      if (!moved && !repaired && !owes(current)) return { status: 'unchanged' };
      if (moved) row.updatedAt = now;
      const minted = await mintRow(row);
      await repo.upsert(row, { etag: current._etag });
      return { status: 'saved', minted, moved, repaired };
    });
    if (['conflict', 'missing'].includes(written.status)) return { action: 'failed', status: written.status };
    if (written.status === 'stale') return stale();
    tally(written.repaired);
    // A mint alone is not an update: it counts in `shortLinks` and leaves `updatedAt` alone.
    if (written.moved) summary.updated++;
    return { action: written.status === 'saved' ? 'updated' : 'unchanged', ...result };
  };

  return { write, heal, mint, writeMinting, healLeftOver: () => healLeftOver };
}

/**
 * One pushed Track project, written live off point reads with its whole {phases} and {works}. Resolves `{action}`
 * as `write` does; the Eagle id read's `DUPLICATE_ID` throws.
 */
async function writeTrackProject(apiProject, { phases, works, pushedAt = null, deps = {} } = {}) {
  const repo = deps.projects || require('../repositories/projects');
  const writer = rowWriter({
    repo, links: deps.links || linksRepository, live: true, now: new Date().toISOString(),
    skipLinkUpkeep: true, push: true, summary: emptySummary(0),
    lookup: {
      stored: (id) => repo.getById(systemAccess(), id),
      eagleOnly: (guid) => repo.readForWrite(eagleOnlyProjectId(guid)).then(row => (row?.sourceSystem === 'eagle' ? row : null)),
      native: (guid) => repo.readForWriteByEagleId(guid).then(row => (isNativeProject(row) ? row : null))
    }
  });
  const result = await writer.write(apiProject, { phases, works, pushedAt });
  if (result.action === 'skipped') logger.warn('[track-push] project skipped', { id: String(apiProject.id), reason: result.reason });
  return result;
}

const emptySummary = (trackProjects) => ({ trackProjects, created: 0, updated: 0, relinked: 0, skippedApiRows: 0,
  orphaned: 0, phases: 0, works: 0, shortLinks: 0, healed: 0, nativeClash: 0, held: 0, stateMoved: 0, stale: 0, adopted: 0,
  derivedDrift: 0, failures: 0, investment: { appended: 0, closed: 0, unreadable: 0, full: 0 } });

module.exports = { HEAL_CAP, trackChanges, writeTrackProject, rowWriter, emptySummary, owesLink, foldTwin, settleTwin };
