'use strict';

/**
 * One-way export: DEMI's `chunks` container -> eagle-search's `/ingest/eagle-chunks`.
 *
 * **The source is never written to.** This script only reads Cosmos; there is no code path here
 * that can modify or delete a chunk. That matters more than usual: DEMI's chunk corpus is the only
 * extracted copy of this text that exists anywhere, it has no backup, and nothing else can
 * regenerate it at reasonable cost.
 *
 * WHY THIS RUNS HERE AND NOT IN eagle-search. `demi-cosmos-dev` is private-endpoint-only and
 * keyless, so it is reachable from inside this VNet as `demi-identity-dev` and from nowhere else.
 * eagle-search would need a cross-resource-group Cosmos data-plane grant, and Cosmos NoSQL role
 * assignments are not portal-manageable — they live in DEMI's Bicep. Pushing from here instead uses
 * a grant that already exists and changes nobody's IaC.
 *
 * WHY IT IS SAFE TO SEND OVER PUBLIC HTTPS. eagle-search **discards** the `read[]` on an inbound
 * chunk and re-stamps it from the parent document in its own `eagle-documents` index. No access
 * control travels in this payload, so a compromised export could not widen anything — it could only
 * deliver text that is already public. All 60,661 chunked documents are `read: public`; the 878
 * non-public Eagle documents have no chunks here.
 *
 * MUST RUN INSIDE THE APP CONTAINER, over the App Service SSH tunnel — not Kudu's /api/command,
 * whose SCM container has no managed-identity endpoint. See README.md for the recipe.
 *
 * A full run is hours, so run it DETACHED — `nohup ... > /tmp/export.log 2>&1 &`. The App Service
 * SSH tunnel dies on its own schedule and would otherwise take the run with it.
 *
 * Usage:
 *   node src/scripts/export-chunks-to-eagle.js --target <url> --key <ingest-key> [--live]
 *                                              [--limit N] [--batch 1000] [--resume <token>]
 *   node src/scripts/export-chunks-to-eagle.js --count
 *
 *   --target   eagle-search base URL, e.g. https://eagle-search-api-dev.azurewebsites.net
 *              Phase 7 points this at test or prod; nothing else changes.
 *   --live     actually push. WITHOUT THIS NOTHING IS SENT.
 *   --limit    stop after N chunks, for a costed trial run
 *   --resume   continuation token from a previous run's checkpoint line
 *   --count    print the total chunk count and exit — the parity target for the backfill gate,
 *              read over the same connection the export uses rather than a separate hand-run query
 */

const cosmos = require('../db/cosmos-nosql');

const CONTAINER = 'chunks';
const DEFAULT_BATCH = 1000;

function parseArgs(argv) {
  const args = { live: false, count: false, limit: Infinity, batch: DEFAULT_BATCH, target: '', key: '', resume: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (a === '--count') args.count = true;
    else if (a === '--target') args.target = argv[++i].replace(/\/$/, '');
    else if (a === '--key') args.key = argv[++i];
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (a === '--batch') args.batch = parseInt(argv[++i], 10);
    else if (a === '--resume') args.resume = argv[++i];
  }
  return args;
}

/**
 * Only the fields eagle-search keeps. `read` is deliberately NOT selected — it is re-stamped at the
 * destination, so shipping it would be sending an ACL that is going to be thrown away, and would
 * make the payload look like it carries access control when it does not.
 */
const SELECT = 'SELECT c.documentId, c.pageNumber, c.chunkIndex, c.content FROM c';

/** eagle-search's key charset allows only letters, digits, `-`, `_` and `=`. DEMI's `::` form is illegal there. */
function eagleKey(chunk) {
  return `${chunk.documentId}_p${chunk.pageNumber ?? 0}_c${chunk.chunkIndex ?? 0}`;
}

async function pushBatch(args, chunks) {
  const body = JSON.stringify(
    chunks.map((c) => ({
      id: eagleKey(c),
      documentId: String(c.documentId),
      content: c.content,
      pageNumber: typeof c.pageNumber === 'number' ? c.pageNumber : 0,
      ...(typeof c.chunkIndex === 'number' && { chunkIndex: c.chunkIndex }),
    }))
  );

  // A string body, not a stream: App Service drops chunked request bodies — the app reads zero
  // bytes and answers 400 — so Content-Length has to be set.
  const res = await fetch(`${args.target}/ingest/eagle-chunks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ingest-key': args.key },
    body,
    signal: AbortSignal.timeout(180000),
  });

  if (!res.ok && res.status !== 207) {
    throw new Error(`ingest failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

/** How often to print a resumable checkpoint. Every page would drown the log; every 10 costs at most 10 pages of replay. */
const CHECKPOINT_EVERY = 10;

(async () => {
  const args = parseArgs(process.argv.slice(2));

  if (args.count) {
    const r = await cosmos.query(CONTAINER, { query: 'SELECT VALUE COUNT(1) FROM c', parameters: [] }, {});
    console.log(`chunks: ${r.items[0]}   (~${Math.round(r.requestCharge || 0)} RU)`);
    return;
  }

  if (!args.target || !args.key) {
    console.error('--target and --key are required');
    process.exit(1);
  }
  if (!args.live) console.log('DRY RUN — nothing will be sent. Add --live to push.');
  console.log(`target: ${args.target}   batch: ${args.batch}   limit: ${args.limit}`);

  let token = args.resume;
  let read = 0;
  let written = 0;
  let orphans = 0;
  let failed = 0;
  let ru = 0;
  let pages = 0;
  const started = Date.now();

  // The push for the page BEFORE the one being fetched. Reading Cosmos and pushing to eagle-search
  // are independent, and doing them strictly in turn is what made the first measured run ~5,000
  // chunks/min. One in flight is the whole win; a pool would add failure modes for no more speed.
  let inflight = null;
  const settle = async () => {
    if (!inflight) return;
    const r = await inflight;
    inflight = null;
    written += r.written ?? 0;
    orphans += r.orphans ?? 0;
    failed += r.failed ?? 0;
  };

  do {
    const resumedFrom = token;
    const page = await cosmos.query(
      CONTAINER,
      // `parameters: []` is not optional — assertQuerySpec rejects a spec without it, which is
      // the guard that stops a hand-built query string reaching Cosmos unparameterised.
      { query: SELECT, parameters: [] },
      { maxItemCount: args.batch, continuationToken: token }
    );
    token = page.continuationToken;
    ru += page.requestCharge || 0;
    pages++;
    if (page.items.length === 0) break;

    const slice = page.items.slice(0, Math.max(0, args.limit - read));
    read += slice.length;

    // Settle the previous push before starting this one, so at most one batch is ever unaccounted.
    await settle();
    if (args.live && slice.length) {
      inflight = pushBatch(args, slice);
      // A floating promise that rejects before the next `settle()` would be an unhandled rejection,
      // which Node turns into a process exit that skips the catch below. Attaching a no-op handler
      // marks it handled; `await inflight` in settle() still rejects and still reaches that catch.
      inflight.catch(() => {});
    }

    // The checkpoint is printed IN FULL and on its own line. It is the only copy of the token, a
    // truncated one resumes nothing, and a detached run has no scrollback to read it back from.
    // `resumedFrom` — not `token` — is the token that fetched the page now in flight, so resuming
    // replays that page rather than skipping it. Writes are mergeOrUpload on a deterministic id,
    // so a replay is idempotent; a skip would be a silent hole.
    if (pages % CHECKPOINT_EVERY === 0) {
      console.log(
        `checkpoint  read ${read}  written ${written}  orphans ${orphans}  failed ${failed}  RU ${Math.round(ru)}` +
          (resumedFrom ? `  --resume ${resumedFrom}` : '  (from the start)')
      );
    }
    if (read >= args.limit) break;
  } while (token);

  await settle();

  const mins = (Date.now() - started) / 60000;
  console.log(
    `done in ${mins.toFixed(1)} min — read ${read}, written ${written}, orphans ${orphans}, ` +
      `failed ${failed}, ~${Math.round(ru)} RU, ${Math.round(read / Math.max(mins, 0.01))} chunks/min`
  );
  // Orphans are chunks whose parent document is not in eagle-documents; eagle-search drops them
  // rather than writing text nobody has been granted access to. A large number means the document
  // sync has not run, not that the export is broken.
  if (orphans) console.log(`note: ${orphans} chunks had no indexed parent document and were dropped by eagle-search`);
  if (failed) process.exit(1);
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
