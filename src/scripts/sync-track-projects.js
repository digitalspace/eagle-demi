'use strict';

/**
 * Hold DEMI's project records in step with Track's project list.
 *
 * Runs inside the nightly Track sync (`sync-track-teams.js`) on the list that run already fetched:
 * one `GET /api/v1/projects` per night feeds both this and the closed-project credential sweep.
 * That run also hands over the work phases it pulled (`sources.fetchTrackWorkPhases`), so the
 * assessment rail eagle-public draws is written by the same pass that writes the names.
 *
 * A RE-MERGE MUST NEVER MOVE A RECORD'S LEVEL. `mergeTrackProject` derives `read` from the Eagle
 * record every time it is called, so re-running it over a stored row would rewrite an ACL that
 * `PUT /api/projects/:id/level` set — the only route allowed to widen anything. The stored
 * `read`, `isPublished` and `vis` are therefore carried unconditionally and only the Track-owned
 * fields are written.
 *
 * NOTHING IS DELETED. A DEMI record Track no longer lists is counted as `orphaned` and left alone:
 * Eagle-only and hand-created projects are legitimate, and a feed that came back short would
 * otherwise take the registry with it.
 */

const { readForLevel, systemAccess } = require('../helpers/access-sql');
const { ensureProjectShortLink, needsSlugMigration } = require('../helpers/short-links');
const { writeGuarded } = require('../helpers/etag-write');
const { TRACK_PRECEDENCE, mergeTrackProject } = require('../merge/project');
const { trackApiToExtract } = require('../seed/sources');
const linksRepository = require('../repositories/links');
const { logger } = require('../utils/logger');

const TRACK_FIELDS = TRACK_PRECEDENCE.map(([target]) => target);

/**
 * The Track-owned fields whose stored value the feed disagrees with — all scalars, so a plain
 * compare. A field the merge left undefined is one neither Track nor Eagle supplied, and is left
 * alone rather than written: that is the same rule TRACK_PRECEDENCE itself follows, so an emptied
 * upstream column cannot blank a populated row.
 *
 * Centroid, `epic_guid` and the Eagle match are NOT compared here: re-deriving them is the seed's
 * job, and this step exists to keep names, states and certificates current.
 *
 * `phases` is the one Track-owned field that is not a scalar, so it is compared by value. Both
 * sides come out of the same mapper, so key order is stable and a serialised compare holds.
 */
function trackChanges(existing, merged) {
  const changes = {};
  for (const field of TRACK_FIELDS) {
    if (merged[field] !== undefined && merged[field] !== existing[field]) {
      changes[field] = merged[field];
    }
  }
  if (merged.phases && JSON.stringify(merged.phases) !== JSON.stringify(existing.phases)) {
    changes.phases = merged.phases;
  }
  return changes;
}

const eagleOf = (row) => (row.sources || {}).eagle || null;

/** A row with a public page and no code yet, or still on a pre-slug random one. */
const owesLink = (row) => Boolean(row.eagleId) && (!row.shortCode || needsSlugMigration(row));

/** Cosmos is private-endpoint-only, so a CLI dry run off-platform has no repository to ask. */
function projectsRepository() {
  if (process.env.COSMOS_ENDPOINT) return require('../repositories/projects');
  logger.warn('[track-projects] COSMOS_ENDPOINT not set: project sync reported as 0');
  return null;
}

/**
 * @param {Array}  apiProjects  raw `GET /api/v1/projects` rows
 * @param {object} [opts]       {live} write, {deps} test seam {projects, links}, {now} fixed timestamp,
 *                              {phases} Map of Track project id -> work phases.
 *                              `deps.links` is the links repository, injected by the tests.
 */
async function syncProjects(apiProjects, opts = {}) {
  const { live = false, deps = {}, phases = new Map() } = opts;
  const rows = apiProjects || [];
  const summary = {
    trackProjects: rows.length,
    created: 0, updated: 0, relinked: 0, skippedApiRows: 0, orphaned: 0, phases: 0,
    shortLinks: 0, failures: 0
  };

  const repo = deps.projects || projectsRepository();
  if (!repo) return summary;
  const linkRepos = { links: deps.links || linksRepository, projects: repo };
  const reread = (id) => () => repo.getById(systemAccess(), id);
  const lost = (id) => (_current, attempt) =>
    logger.warn('[track-projects] project write lost its etag race, rebuilding', { id, attempt });

  /** Mints on `project` and says whether its code moved. */
  const mint = async (project) => {
    const before = project.shortCode;
    await ensureProjectShortLink(project, linkRepos);
    return project.shortCode !== before;
  };

  /** Inserts a row this run read as absent. One created behind the run is the next run's. */
  const insert = async (id, row) => {
    const written = await writeGuarded({
      existing: null,
      reread: reread(id),
      attempt: async (current) => {
        if (current) return { status: 'exists' };
        const minted = await mint(row);
        await repo.upsert(row, { create: true });
        return { status: 'saved', minted };
      },
      onLost: lost(id)
    });
    if (written.minted) summary.shortLinks++;
    if (written.status !== 'saved') {
      logger.warn('[track-projects] project created behind this run, left for the next', { id });
    }
  };

  const now = opts.now || new Date().toISOString();
  // systemAccess(), because a scoped context would list only what it can see and then create a
  // second copy of every record it was not shown.
  const { items } = await repo.listVisible(systemAccess(), {});
  const stored = new Map(items.map(p => [String(p.id), p]));
  // `buildRegistry` matches Track to Eagle on `epic_guid`, so a project DEMI holds as an Eagle-only
  // row is this same project under its pre-Track key, not a record Track has never seen.
  // `sourceSystem === 'eagle'` is the repository's own definition of that set (`listEagleOnlyIds`).
  const eagleOnly = new Map(
    items.filter(p => p.sourceSystem === 'eagle' && p.eagleId).map(p => [String(p.eagleId), p])
  );
  const listed = new Set();
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
    // Every merge below takes the same options; the phase list is per project, so it is read once.
    const mergeOpts = { now, phases: phases.get(id) };
    if (mergeOpts.phases) summary.phases++;

    try {
      if (relink) {
        // A RE-KEY, NOT A NEW RECORD. `...relink` keeps the boundary stamps and `sources.wildfire`,
        // the merge re-owns the identity and the Track fields, and `read`/`isPublished`/`vis` come
        // back off the stored row: a re-key must not move a level either.
        //
        // The `eagle-<id>` row is left exactly as it stands, because that is what the seed does
        // with it: `buildRegistry` simply stops producing it, and `--reconcile` keys Eagle-only
        // rows on `eagleId` against the Eagle fetch, so a row whose Eagle project still exists is
        // not surplus. Removing one is `purgeProject`'s job, and that cascades to its documents.
        const merged = mergeTrackProject(track, eagleOf(relink), mergeOpts);
        summary.relinked++;
        rekeyed.add(String(relink.eagleId));
        if (live) {
          await insert(id, { ...relink, ...merged, read: relink.read, isPublished: relink.isPublished });
        }
        continue;
      }

      if (!existing) {
        const merged = mergeTrackProject(track, null, mergeOpts);
        // Admission is level 1 (TODO-rbac.md P3-3). The merge's own default for an unmatched
        // Track project is level 2, and no job may widen anything.
        merged.read = readForLevel(1);
        merged.isPublished = false;
        summary.created++;
        if (live) await insert(id, merged);
        continue;
      }

      // `POST /projects` writes `sources: {}`, and close-unpublished-track-projects.js reads that
      // absence to tell a deliberately published API row from a merge-produced Track-only one.
      // Mirroring onto it would stamp `sources.track` on and cost it `public` on the next close
      // run. `sourceSystem` cannot stand in: the API route writes `'track'` too.
      if (!(existing.sources || {}).track) {
        summary.skippedApiRows++;
        continue;
      }

      const changed = Object.keys(
        trackChanges(existing, mergeTrackProject(track, eagleOf(existing), mergeOpts))
      ).length > 0;
      // A stored project with no code yet, or still on a pre-slug random one, is written even when
      // Track says nothing new: that is how the projects that predate slugs get one. The migration
      // stamps `shortCodeSource`, so the next night skips the row again.
      if (!changed && !owesLink(existing)) continue;
      // A mint alone is not an update: it counts in `shortLinks` and leaves `updatedAt` alone.
      if (changed) summary.updated++;
      if (!live) {
        if (owesLink(existing)) summary.shortLinks++;
        continue;
      }

      // Rebuilt off the row that stored, guarded on its revision: a whole-item write from the
      // run-start snapshot would undo a staff code set while the run was going.
      const written = await writeGuarded({
        existing,
        reread: reread(id),
        attempt: async (current) => {
          if (!current) return { status: 'missing' };
          const changes = trackChanges(current, mergeTrackProject(track, eagleOf(current), mergeOpts));
          const moved = Object.keys(changes).length > 0;
          if (!moved && !owesLink(current)) return { status: 'unchanged' };
          const row = { ...current, ...changes, sources: { ...current.sources, track } };
          if (moved) row.updatedAt = now;
          const minted = await mint(row);
          await repo.upsert(row, { etag: current._etag });
          return { status: 'saved', minted };
        },
        onLost: lost(id)
      });
      if (written.minted) summary.shortLinks++;
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

  // Eagle-only rows are in no Track row, so this is the only nightly pass that mints or migrates
  // their codes.
  for (const row of eagleOnly.values()) {
    if (!owesLink(row) || rekeyed.has(String(row.eagleId))) continue;
    if (!live) {
      summary.shortLinks++;
      continue;
    }
    try {
      const written = await writeGuarded({
        existing: row,
        reread: reread(row.id),
        attempt: async (current) => {
          if (!current || !owesLink(current)) return { status: 'skipped' };
          const next = { ...current };
          const minted = await mint(next);
          // A patch of the three fields: nothing else on an Eagle-only row is this job's to write.
          await repo.patchShortLink(current.id, next, current._etag);
          return { status: 'saved', minted };
        },
        onLost: lost(row.id)
      });
      if (written.minted) summary.shortLinks++;
      if (written.status === 'conflict') {
        summary.failures++;
        logger.error(`[track-projects] project ${row.id} short code not migrated`, { status: written.status });
      }
    } catch (err) {
      summary.failures++;
      logger.error(`[track-projects] project ${row.id} short code migration failed`, { error: err.message });
    }
  }

  return summary;
}

module.exports = { trackChanges, syncProjects };
