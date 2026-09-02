'use strict';

/**
 * Hold DEMI's project records in step with Track's project list.
 *
 * Runs inside the nightly Track sync (`sync-track-teams.js`) on the list that run already fetched:
 * one `GET /api/v1/projects` per night feeds both this and the closed-project credential sweep.
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
const { TRACK_PRECEDENCE, mergeTrackProject } = require('../merge/project');
const { trackApiToExtract } = require('../seed/sources');
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
 */
function trackChanges(existing, merged) {
  const changes = {};
  for (const field of TRACK_FIELDS) {
    if (merged[field] !== undefined && merged[field] !== existing[field]) {
      changes[field] = merged[field];
    }
  }
  return changes;
}

/** Cosmos is private-endpoint-only, so a CLI dry run off-platform has no repository to ask. */
function projectsRepository() {
  if (process.env.COSMOS_ENDPOINT) return require('../repositories/projects');
  logger.warn('[track-projects] COSMOS_ENDPOINT not set: project sync reported as 0');
  return null;
}

/**
 * @param {Array}  apiProjects  raw `GET /api/v1/projects` rows
 * @param {object} [opts]       {live} write, {deps} test seam {projects}, {now} fixed timestamp
 */
async function syncProjects(apiProjects, opts = {}) {
  const { live = false, deps = {} } = opts;
  const rows = apiProjects || [];
  const summary = { trackProjects: rows.length, created: 0, updated: 0, orphaned: 0, failures: 0 };

  const repo = deps.projects || projectsRepository();
  if (!repo) return summary;

  const now = opts.now || new Date().toISOString();
  // systemAccess(), because a scoped context would list only what it can see and then create a
  // second copy of every record it was not shown.
  const { items } = await repo.listVisible(systemAccess(), {});
  const stored = new Map(items.map(p => [String(p.id), p]));
  const listed = new Set();

  for (const apiProject of rows) {
    const track = trackApiToExtract(apiProject);
    const id = String(track.track_project_id);
    listed.add(id);
    const existing = stored.get(id);

    try {
      if (!existing) {
        const merged = mergeTrackProject(track, null, { now });
        // Admission is level 1 (TODO-rbac.md P3-3). The merge's own default for an unmatched
        // Track project is level 2, and no job may widen anything.
        merged.read = readForLevel(1);
        merged.isPublished = false;
        summary.created++;
        if (live) await repo.upsert(merged);
        continue;
      }

      const merged = mergeTrackProject(track, (existing.sources || {}).eagle || null, { now });
      const changes = trackChanges(existing, merged);
      if (!Object.keys(changes).length) continue;
      summary.updated++;
      if (!live) continue;

      // `...existing` first and a change set of Track-owned fields only: `read`, `isPublished`,
      // `vis`, the boundary stamps and `sources.wildfire` all survive an upsert that replaces the
      // whole item.
      await repo.upsert({
        ...existing,
        ...changes,
        sources: { ...existing.sources, track },
        updatedAt: now
      });
    } catch (err) {
      summary.failures++;
      logger.error(`[track-projects] project ${id} failed`, { error: err.message });
    }
  }

  for (const [id, project] of stored) {
    if (!listed.has(id) && project.sourceSystem === 'track') summary.orphaned++;
  }

  return summary;
}

module.exports = { TRACK_FIELDS, trackChanges, syncProjects };
