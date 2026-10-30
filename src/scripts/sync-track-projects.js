'use strict';

/**
 * DEMI project records kept in step with Track's list. Stored `read`, `isPublished`, `vis` carry
 * over, since a re-merge would undo a hand-set level; a record Track omits is never deleted.
 */

const { readForLevel, systemAccess } = require('../helpers/access-sql');
const {
  ensureProjectShortLink, needsSlugMigration, isWrongHostDefault, releaseCreatedCode, repointProjectLinks
} = require('../helpers/short-links');
const { writeGuarded } = require('../helpers/etag-write');
const { TRACK_PRECEDENCE, mergeTrackProject } = require('../merge/project');
const { deriveAssessments } = require('../merge/assessments');
const { SYNC_STATE_FIELDS } = require('../ownership/sync-out');
const { clientToken, fetchTrackProjects, trackApiToExtract } = require('../seed/sources');
const config = require('../config');
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

function trackChanges(existing, merged) {
  const changes = {};
  for (const field of TRACK_FIELDS) {
    if (merged[field] !== undefined && merged[field] !== existing[field]) {
      changes[field] = merged[field];
    }
  }
  for (const field of TRACK_ARRAY_FIELDS) {
    if (merged[field] && JSON.stringify(merged[field]) !== JSON.stringify(existing[field])) {
      changes[field] = merged[field];
    }
  }
  return changes;
}

const eagleOf = (row) => (row.sources || {}).eagle || null;

/** `row` with `assessments`, `phaseIds` and `activeWork` derived again, keeping names off `stored`'s. */
const withDerived = (row, stored) =>
  Object.assign(row, deriveAssessments(row, { previous: stored && stored.assessments }));

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
      if (made.has(record.id) || await links.getById(record.id)) {
        throw Object.assign(new Error('Conflict'), { code: 409 });
      }
      made.set(record.id, record);
      return record;
    },
    repoint: async (code, url) => {
      const record = made.get(code) || await links.getById(code);
      if (!record) return null;
      const moved = { ...record, url, updatedAt: new Date().toISOString() };
      made.set(code, moved);
      return moved;
    }
  };
}

/** Cosmos is private-endpoint-only, so a CLI dry run off-platform has no repository to ask. */
function projectsRepository() {
  if (process.env.COSMOS_ENDPOINT) return require('../repositories/projects');
  logger.warn('[track-projects] COSMOS_ENDPOINT not set: project sync reported as 0');
  return null;
}

/**
 * @param {Array}  apiProjects  raw `GET /api/v1/projects` rows
 * @param {object} [opts]       {live}, {deps} {projects, links}, {now}, {phases}/{works} Maps
 *                              by Track project id, {poll} skip link heal, slugs, Eagle-only pass
 */
async function syncProjects(apiProjects, opts = {}) {
  const { live = false, deps = {}, phases = new Map(), works = new Map(), poll = false } = opts;
  const rows = apiProjects || [];
  const summary = {
    trackProjects: rows.length,
    created: 0, updated: 0, relinked: 0, skippedApiRows: 0, orphaned: 0, phases: 0, works: 0,
    shortLinks: 0, healed: 0, failures: 0
  };

  const repo = deps.projects || projectsRepository();
  if (!repo) return summary;
  const links = deps.links || linksRepository;
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
    if (poll || !project.eagleId || project.shortLinkUrl) return;
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
      logger.error(`[track-projects] project ${project.id} link heal failed`, { error: err.message });
    }
  };

  /**
   * Inserts a row this run read as absent. One created behind the run is the next run's.
   * `build` runs per live try, so a row built off another stored row sees that row as it stands.
   */
  const insert = async (id, build) => {
    if (!live) {
      if (await mint(await build())) summary.shortLinks++;
      return;
    }
    const written = await writeMinting(id, null, async (current, mintRow) => {
      if (current) return { status: 'exists' };
      // A copy per try: a lost try's code is released before this one, so it must not ride along.
      const fresh = { ...(await build()) };
      const minted = await mintRow(fresh);
      await repo.upsert(fresh, { create: true });
      return { status: 'saved', minted };
    });
    if (written.status !== 'saved') {
      logger.warn('[track-projects] project created behind this run, left for the next', { id });
    }
  };

  const now = opts.now || new Date().toISOString();
  // systemAccess(), because a scoped context would list only what it can see and then create a
  // second copy of every record it was not shown.
  const { items } = await repo.listVisible(systemAccess(), {});
  const stored = new Map(items.map(p => [String(p.id), p]));
  // An Eagle-only row (`sourceSystem === 'eagle'`, as in `listEagleOnlyIds`) whose guid Track lists
  // is the same project under its pre-Track key, as `buildRegistry` matches on `epic_guid`.
  const eagleOnly = new Map(
    items.filter(p => p.sourceSystem === 'eagle' && p.eagleId).map(p => [String(p.eagleId), p])
  );
  const listed = new Set();
  // A poll writes a stored row only when Track moved it; the migration-only write is the night's.
  const owes = (row) => !poll && owesLink(row);
  // An Eagle-only row whose project now lives under a Track id is dead weight; its code moved too.
  const rekeyed = new Set(
    items.filter(p => p.sourceSystem !== 'eagle' && p.eagleId).map(p => String(p.eagleId))
  );

  for (const apiProject of rows) {
    const track = trackApiToExtract(apiProject);
    const id = String(track.track_project_id);
    listed.add(id);
    const existing = stored.get(id);
    const guid = track.epic_guid ? String(track.epic_guid) : null;
    const relink = !existing && guid ? eagleOnly.get(guid) : null;
    // Every merge below takes the same options; the phase and work lists are per project, so they
    // are read once.
    const mergeOpts = { now, phases: phases.get(id), works: works.get(id) };
    if (mergeOpts.phases) summary.phases++;
    if (mergeOpts.works) summary.works++;

    try {
      if (relink) {
        // A re-key, not a new record: it keeps the level and stamps; the `eagle-<id>` row stays,
        // as in the seed, because removing one is `purgeProject`'s job and cascades to documents.
        summary.relinked++;
        rekeyed.add(String(relink.eagleId));
        await heal(relink);
        // The twin as stored now, not at run start: a tags PUT or a narrowing since must carry.
        await insert(id, async () => {
          const twin = (live && await repo.getById(systemAccess(), relink.id)) || relink;
          const merged = mergeTrackProject(track, eagleOf(twin), mergeOpts);
          // The Track row is a new record: it must not inherit the twin's sync-out state.
          const carried = Object.fromEntries(Object.entries(twin).filter(([k]) => !SYNC_STATE_FIELDS.includes(k)));
          return withDerived({ ...carried, ...merged, read: twin.read, isPublished: twin.isPublished }, twin);
        });
        continue;
      }

      if (!existing) {
        const merged = mergeTrackProject(track, null, mergeOpts);
        // Admission is level 1: the merge's default for an unmatched Track project is level 2,
        // and no job may widen anything.
        merged.read = readForLevel(1);
        merged.isPublished = false;
        withDerived(merged, null);
        summary.created++;
        await insert(id, async () => merged);
        continue;
      }

      // An API row (`sources: {}`) is skipped: stamping `sources.track` would make
      // close-unpublished-track-projects.js unpublish it; `sourceSystem` cannot tell them apart.
      if (!(existing.sources || {}).track) {
        summary.skippedApiRows++;
        continue;
      }
      await heal(existing);

      const changed = Object.keys(
        trackChanges(existing, mergeTrackProject(track, eagleOf(existing), mergeOpts))
      ).length > 0;
      // A row owing a slug code is written even when Track says nothing new; the migration stamps
      // `shortCodeSource`, so the next night skips it.
      if (!changed && !owes(existing)) continue;
      // A mint alone is not an update: it counts in `shortLinks` and leaves `updatedAt` alone.
      if (changed) summary.updated++;
      if (!live) {
        // A migration with no free slug keeps its code, so only a real move counts.
        if (owesLink(existing) && await mint({ ...existing })) summary.shortLinks++;
        continue;
      }

      // Rebuilt off the row that stored, guarded on its revision: a whole-item write from the
      // run-start snapshot would undo a staff code set while the run was going.
      const written = await writeMinting(id, existing, async (current, mintRow) => {
        if (!current) return { status: 'missing' };
        const changes = trackChanges(current, mergeTrackProject(track, eagleOf(current), mergeOpts));
        const moved = Object.keys(changes).length > 0;
        if (!moved && !owes(current)) return { status: 'unchanged' };
        const row = withDerived({ ...current, ...changes, sources: { ...current.sources, track } }, current);
        if (moved) row.updatedAt = now;
        const minted = await mintRow(row);
        await repo.upsert(row, { etag: current._etag });
        return { status: 'saved', minted };
      });
      if (written.status === 'conflict' || written.status === 'missing') {
        summary.failures++;
        logger.error(`[track-projects] project ${id} not written`, { status: written.status });
      }
    } catch (err) {
      summary.failures++;
      logger.error(`[track-projects] project ${id} failed`, { error: err.message });
    }
  }

  for (const [id, project] of stored) {
    if (!listed.has(id) && project.sourceSystem === 'track') summary.orphaned++;
  }

  // Eagle-only rows are in no Track row, so this is the only nightly pass that heals, mints or
  // migrates their codes.
  for (const row of poll ? [] : eagleOnly.values()) {
    if (rekeyed.has(String(row.eagleId))) continue;
    await heal(row);
    if (!owesLink(row)) continue;
    try {
      if (!live) {
        if (await mint({ ...row })) summary.shortLinks++;
        continue;
      }
      const written = await writeMinting(row.id, row, async (current, mintRow) => {
        if (!current || !owesLink(current)) return { status: 'skipped' };
        const next = { ...current };
        const minted = await mintRow(next);
        // A patch of the three fields: nothing else on an Eagle-only row is this job's to write.
        await repo.patchShortLink(current.id, next, current._etag);
        return { status: 'saved', minted };
      });
      if (written.status === 'conflict') {
        summary.failures++;
        logger.error(`[track-projects] project ${row.id} short code not migrated`, { status: written.status });
      }
    } catch (err) {
      summary.failures++;
      logger.error(`[track-projects] project ${row.id} short code migration failed`, { error: err.message });
    }
  }

  if (healLeftOver) {
    logger.warn('[track-projects] heal cap reached, the rest wait for the next run', { cap: HEAL_CAP });
  }
  return summary;
}

const POLL_FIELDS = ['trackProjects', 'created', 'updated', 'relinked', 'skippedApiRows', 'orphaned',
  'shortLinks', 'failures'];

/** The line a log alert matches. A run that failed before the mirror reports its counts as 0. */
const pollLine = (s) => `[track-projects-poll] mode=${s.mode} ` +
  POLL_FIELDS.map(field => `${field}=${s[field] || 0}`).join(' ');

/**
 * The projects-only poll: one Track token, one `GET /api/v1/projects`, then the mirror.
 *
 * @param {object} [opts] {live} write, {deps} test seam {kc, fetchJson, projects, links}
 */
async function run({ live = false, deps = {} } = {}) {
  const kc = deps.kc || { clientToken };
  let summary;
  try {
    const token = await kc.clientToken(config.trackClientId, config.trackClientSecret);
    const projects = await fetchTrackProjects(token, deps.fetchJson);
    summary = await syncProjects(projects, { live, deps, poll: true });
  } catch (err) {
    logger.error('[track-projects-poll] run failed', { error: err.message, stack: err.stack });
    summary = { failures: 1 };
  }
  summary.mode = live ? 'live' : 'dry-run';
  logger.info(pollLine(summary));
  return summary;
}

module.exports = { HEAL_CAP, trackChanges, syncProjects, run };
