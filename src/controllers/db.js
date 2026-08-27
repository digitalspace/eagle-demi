'use strict';

const { systemAccess } = require('../helpers/access-sql');
const projectsRepo = require('../repositories/projects');
const documentsRepo = require('../repositories/documents');
const boundariesRepo = require('../repositories/boundaries');
const aiSearch = require('../search/ai-search');
const { serverError } = require('../helpers/response');

/**
 * Containers whose index-build state is worth reporting. A bulk load leaves the index lagging the
 * rows, and a reader that arrives before it reaches 100 sees a short answer rather than an error.
 */
const INDEXED_CONTAINERS = ['chunks', 'documents', 'projects'];

/**
 * Index-build progress per container, as a percentage.
 *
 * Exposed through the API rather than read out of band: Cosmos sits behind a private endpoint on a
 * keyless account, so the app's managed identity is the only thing that can read it, and this is
 * the app. Reused as the pre-cutover gate for any bulk load — see the wiki's ADR-005 (Cosmos full-text search ruled out).
 */
async function getIndexProgress() {
  // No USE_COSMOS_NOSQL gate. It used to return null when the flag was unset, which is now the
  // wrong answer in the only remaining direction: with one data layer, an unset flag would make
  // this report "inactive" for a database that is very much serving traffic.
  const cosmosNoSql = require('../db/cosmos-nosql');
  const entries = await Promise.all(INDEXED_CONTAINERS.map(async (name) => {
    try {
      return [name, await cosmosNoSql.indexProgress(name)];
    } catch (err) {
      // One missing or unreadable container must not deny the whole reading.
      return [name, `error: ${err.message}`];
    }
  }));
  return Object.fromEntries(entries);
}

/**
 * GET /admin/index-progress — index-build state, and nothing else.
 *
 * Deliberately NOT folded into /db/stats, even now that stats no longer runs the legacy Mongo
 * counts that used to make it hang for minutes. An operational reading has to be independent of
 * the thing it is used to diagnose: this one issues no container query at all, so it still
 * answers when every count is timing out.
 */
async function getIndexProgressHandler(req, res) {
  try {
    const progress = await getIndexProgress();
    // Which container a DEPLOYED build actually writes chunks to is otherwise unobservable from
    // outside — app settings cannot be read back from the SCM container either, since it gets
    // neither the app's env nor its managed identity. One string removes the guess, and this is
    // exactly the fact that went wrong when chunk writes were pointed at `chunks_fts`.
    const chunks = require('../repositories/chunks');
    // `semantic` belongs on this endpoint for the same reason the container name does: it is a
    // fact about the deployed process that nothing else can observe. Reranking degrades to BM25
    // with a 200 and an identical response shape, so `partial` climbing against `requested` is the
    // only reading that separates "ranking is live" from "the scorecard measures an order no user
    // gets". It reads a plain object — no container query, so this stays the cheap endpoint.
    res.json({
      success: true,
      active: true,
      database: 'demi',
      indexProgress: progress,
      search: { container: chunks.CONTAINER, semantic: aiSearch.semanticStats() }
    });
  } catch (err) {
    return serverError(res, err, 'index progress failed');
  }
}

/**
 * Item counts per container.
 *
 * Every number now comes from the SAME database. This used to run four `countDocuments()` calls
 * against the legacy Mongo-API account (database `epic`) and report them alongside NoSQL index
 * progress — two databases in one response, which is exactly the confusion that let
 * `COSMOS_DATABASE` silently repoint the live app. Those counts are gone with the account.
 *
 * Counts run under systemAccess(): this is an operational reading of the whole database, the
 * route is admin-only, and systemAccess takes no arguments so it cannot be derived from a
 * request.
 */
async function getDbStats(req, res) {
  try {
    const access = systemAccess();

    // Eagle rows Track has no counterpart for are retained and flagged (TODO F17), so the only
    // place their number is visible is here. Counted off `sourceSystem`, the flag itself.
    const [projects, eagleOnlyProjects, documents, boundaries] = await Promise.all([
      projectsRepo.countVisible(access),
      projectsRepo.countEagleOnlyIds(access),
      documentsRepo.countVisible(access),
      boundariesRepo.countVisible(access)
    ]);

    const indexProgress = await getIndexProgress();

    res.json({
      success: true,
      database: 'demi',
      connectionState: 'connected',
      driver: 'azure-cosmos-nosql',
      stats: {
        projects,
        trackProjects: projects - eagleOnlyProjects,
        unlinkedProjects: eagleOnlyProjects,
        documents,
        boundaries
      },
      ...(indexProgress ? { indexProgress } : {})
    });
  } catch (err) {
    return serverError(res, err, 'db stats failed');
  }
}

// The seed and nightly-sync handlers are gone with the Mongo-era scripts behind them
// (sync_from_openshift, seed-and-merge, nightly-sync). `src/scripts/seed-nosql.js` reproduces
// projects, documents and boundaries from the upstream sources, and is run inside the network
// over the App Service SSH tunnel — a 60k-document seed outlives any HTTP request, so it never
// belonged behind a route. See README.md for the recipe.

module.exports = {
  getDbStats,
  getIndexProgressHandler
};
