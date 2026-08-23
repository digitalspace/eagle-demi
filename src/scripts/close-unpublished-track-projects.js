'use strict';

/**
 * Withdraw `public` from projects that have no Eagle counterpart.
 *
 * THE RULE. Product owner, 2026-08-23: *"if track has a project that eagle does not have, this
 * project is NOT public."* Eagle is what publishes; a project that has not reached it has not been
 * published by anyone. `merge/project.js`'s `resolveProjectAcl` now fails closed accordingly.
 *
 * WHY A SCRIPT TOO. The merge change only takes effect on a re-seed, and the rows are already in
 * Cosmos with `public` stamped on them. Measured anonymously against demi-api-test on 2026-08-23,
 * before the fix: **28 projects were publicly readable with no Eagle counterpart**, and 19 of the
 * 27 checked returned **zero** anonymous hits on prod eagle-search — i.e. demi was publishing
 * project names the public prod site does not publish at all.
 *
 * WHY NOT RE-SEED. `seed-nosql.js` rewrites the whole corpus including documents, and
 * `transformDocument` resets `contentExtracted`, which would send ~60,578 documents back through
 * the GPU. This touches two fields on a few dozen project rows.
 *
 * NO DOCUMENT CASCADE, AND THAT IS MEASURED, NOT ASSUMED. A Track-only project has no Eagle
 * counterpart, so the seed had no Eagle documents to attach to it. Sampled 2026-08-23: projects
 * 354, 372, 365, 411 and 413 each return 0 documents. The script asserts this per project rather
 * than trusting it — a project with documents is REPORTED AND SKIPPED, because unpublishing it
 * would need the ACL cascade in `controllers/nosql/project.js`, which has open defects of its own.
 * A non-zero `withDocuments` count means stop and use that path instead.
 *
 * **DRY RUN BY DEFAULT.** `--live` is the mutating flag, matching apply-search-definitions.js,
 * backfill-document-list-ids.js and purge-extraction.js.
 *
 *   node src/scripts/close-unpublished-track-projects.js [--live]
 *
 * Cosmos is private-endpoint-only and keyless, so a live run must execute INSIDE the app container
 * over the App Service SSH tunnel — not Kudu's /api/command, whose SCM container has no
 * managed-identity endpoint. See README.md for the recipe. No search-service grant is needed: this
 * writes to Cosmos and the projects indexer picks the rows up on its PT5M schedule, because a patch
 * moves `_ts` and the data source's high-water mark is `_ts`.
 *
 * VERIFY AFTERWARDS, and verify from OUTSIDE: an anonymous
 * `GET /api/search?dataset=Project&pageSize=500&sortBy=name` must return zero rows with an empty
 * `legacyEagleId`. Counting inside the container proves the write landed, not that the public can
 * no longer see it — the index is a separate copy and lags by up to five minutes.
 */

const projects = require('../repositories/projects');
const documents = require('../repositories/documents');
const cosmos = require('../db/cosmos-nosql');
const { systemAccess } = require('../helpers/access-sql');
// The ACL comes from the MERGE, by calling it — not from a SECURE_ROLES literal. There are two
// such lists (`merge/project.js:22` has three roles, `helpers/access-sql.js:30` has four), and this
// script exists to write what a re-seed would have written. Importing the wrong one leaves the
// backfill and a later re-seed with different arrays on the same rows. No access difference either
// way — `readClause` short-circuits for any of them — but neither module's tests can see the drift,
// because each asserts against its own constant. Asking the merge sidesteps the choice entirely.
const { resolveProjectAcl } = require('../merge/project');

function parseArgs(argv) {
  const args = { live: false };
  for (const a of argv) {
    if (a === '--live') args.live = true;
    else throw new Error(`[close-unpublished] unknown argument: ${a}`);
  }
  return args;
}

/**
 * A project this rule applies to: it came from the MERGE's Track path, no Eagle record was matched,
 * and the row is currently public.
 *
 * BOTH HALVES OF `sources` ARE LOAD-BEARING, and each was learned the hard way.
 *
 * `sources.eagle` and NOT `eagleId`, because those disagree for a category the merge names and
 * counts: `mergeTrackProject` writes `eagleId` from `track.epic_guid` whether or not that guid
 * resolves to anything, so a Track row with a DANGLING guid — 6 of them, pinned at
 * `test/merge/project.test.js:274` as `trackOnlyDanglingGuid` — carries an `eagleId` while
 * `resolveProjectAcl` correctly saw no Eagle record and fails closed. Keying on `eagleId` skipped
 * exactly those 6. `sources.eagle` is the merge's own record of what it matched, so it is the same
 * question `resolveProjectAcl` was asked.
 *
 * `sources.track` REQUIRED, because `sources.eagle` alone does not separate a merge-produced row
 * from an API-created one. `createProject` writes `sources: {}` — deliberately, so the wildfire
 * sync can patch `/sources/wildfire` — together with `eagleId: null`, `sourceSystem: 'track'` and
 * `read: ['public', ...SECURE_ROLES]` when published. That is byte-identical to a Track-only row
 * under a `sources.eagle` test, so without this half a `--live` run would strip `public` from
 * projects somebody deliberately and auditably published through `POST /projects` — the same route
 * the eagle-api-pushes-to-DEMI ingest path will use.
 *
 * The four shapes, and what each answers:
 *
 * | row | `sources.track` | `sources.eagle` | closes? |
 * |---|---|---|---|
 * | merge, Track with no Eagle match | set | null | **yes** |
 * | merge, Track matched to Eagle | set | set | no |
 * | merge, Eagle-only | null | set | no |
 * | `POST /projects` | absent | absent | no |
 *
 * KNOWN GAP, deliberately not covered: the merge also closes an Eagle-MATCHED row whose Eagle
 * record had a missing or empty `read[]`, and this script skips every row with `sources.eagle`, so
 * such a row would stay public until a re-seed. Measured 2026-08-23 and the category is empty —
 * `GET /api/public/search?dataset=Project&pageSize=1000` returns 359 rows on eagle-dev and 358 on
 * prod, and NOT ONE has an empty `read[]` or a `read[]` without `public`. Closing it would mean
 * re-reading Eagle per row to learn what the merge would have written, which is a re-seed.
 */
function needsClosing(project) {
  const sources = project.sources || {};
  const fromMergeTrackPath = Boolean(sources.track);
  const matchedEagle = Boolean(sources.eagle);
  return fromMergeTrackPath && !matchedEagle &&
    Array.isArray(project.read) && project.read.includes('public');
}

/**
 * The ACL a re-seed would write for a project with no Eagle match — asked of the merge itself
 * rather than rebuilt here, so the backfill and a re-seed cannot disagree.
 */
function closedAcl() {
  return resolveProjectAcl(null);
}

/**
 * 1 on a failure OR a skip. A project with documents is work this script deliberately did not do,
 * and a silent 0 would read as "nothing left to close". Extracted and exported so it can be
 * asserted — the sibling `backfill-document-list-ids.js` does the same for the same reason.
 */
function exitCodeFor(summary) {
  return summary.failed > 0 || summary.withDocuments > 0 ? 1 : 0;
}

/**
 * @param {string[]} argv
 * @param {object} [opts]  test seam: {projects, documents, patch, now}
 */
async function closeUnpublished(argv = [], opts = {}) {
  const args = parseArgs(argv);
  const projectsRepo = opts.projects || projects;
  const documentsRepo = opts.documents || documents;
  const patch = opts.patch ||
    ((id, ops) => cosmos.patch(projectsRepo.CONTAINER, String(id), String(id), ops));
  const now = opts.now || new Date().toISOString();

  // systemAccess(), because a scoped context would list only what it can see and silently leave the
  // rest public — a partial run that reports success is worse than none, since nobody re-runs it.
  const access = systemAccess();

  const summary = {
    mode: args.live ? 'live' : 'dry-run',
    scanned: 0,
    matched: 0,
    withDocuments: 0,
    closed: 0,
    failed: 0,
    names: []
  };

  // No `trackOnly`: the point is to see every project, including the ones that clause hides.
  const { items } = await projectsRepo.listVisible(access, {});

  for (const project of items) {
    summary.scanned++;
    if (!needsClosing(project)) continue;
    summary.matched++;
    summary.names.push(`${project.id} ${project.name}`);

    const docs = await documentsRepo.countVisible(access, { projectId: String(project.id) });
    if (docs > 0) {
      // Skipped, not forced. See the docblock: unpublishing a project WITH documents has to go
      // through the ACL cascade, and that path has open defects.
      summary.withDocuments++;
      console.error(
        `[close-unpublished] SKIP ${project.id} "${project.name}" — ${docs} document(s). ` +
        'Use the project controller so the document ACL cascade runs.'
      );
      continue;
    }

    if (!args.live) continue;

    try {
      await patch(project.id, [
        { op: 'set', path: '/read', value: closedAcl() },
        { op: 'set', path: '/isPublished', value: false },
        { op: 'set', path: '/updatedAt', value: now }
      ]);
      summary.closed++;
    } catch (err) {
      summary.failed++;
      console.error(`[close-unpublished] FAILED ${project.id}: ${err.message}`);
    }
  }

  return summary;
}

module.exports = { closeUnpublished, needsClosing, closedAcl, exitCodeFor, parseArgs };

if (require.main === module) {
  closeUnpublished(process.argv.slice(2))
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
      process.exit(exitCodeFor(summary));
    })
    .catch((err) => {
      console.error(`[close-unpublished] ${err.stack || err.message}`);
      process.exit(1);
    });
}
