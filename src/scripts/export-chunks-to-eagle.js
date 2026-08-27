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
 * whose SCM container has no managed-identity endpoint. See README.md for the recipe, including the
 * `IDENTITY_ENDPOINT`/`IDENTITY_HEADER` pair: without those two the Cosmos client cannot authenticate
 * and the failure names VS Code and PowerShell rather than the missing variables.
 *
 * Run it DETACHED — `nohup ... > /home/export.log 2>&1 &`. The SSH tunnel dies on its own schedule
 * and would otherwise take the run with it. `alwaysOn` must be ON for the duration, or App Service
 * unloads the idle app and recycles the container out from under the run.
 *
 * MEASURED, prod backfill 2026-08-20: the full 1,128,733-chunk run took **60.3 minutes — 18,726
 * chunks/min** with one push in flight, against the ~5,000/min this header claimed from the first
 * run. A 5,000-row trial reads 9,593/min; the sustained rate is roughly double that, because the
 * pipelined push stops being the limiting factor once it is warm.
 *
 * Usage:
 *   node src/scripts/export-chunks-to-eagle.js --target <url> --key <ingest-key> [--live]
 *                                              [--limit N] [--batch 1000] [--resume <token>]
 *   node src/scripts/export-chunks-to-eagle.js --count
 *   node src/scripts/export-chunks-to-eagle.js --dump /path/corpus.jsonl        # backup, sends nothing
 *
 *   --target   eagle-search base URL, e.g. https://eagle-search-api-dev.azurewebsites.net
 *              Phase 7 points this at test or prod; nothing else changes.
 *   --live     actually push. WITHOUT THIS NOTHING IS SENT.
 *   --limit    stop after N chunks, for a costed trial run
 *   --resume   continuation token from a previous run's checkpoint line
 *   --count    print the total chunk count and exit — the parity target for the backfill gate,
 *              read over the same connection the export uses rather than a separate hand-run query
 *   --dump     also append every chunk read to this file as JSONL, one object per line
 *
 * WHY --dump EXISTS. The header above is not reassurance, it is a hazard notice: this corpus is the
 * only extracted copy of the text, and `demi-cosmos-test`'s backup is Periodic on an 8-hour
 * retention — measured 2026-08-19 (`backupIntervalInMinutes: 240`, `backupRetentionIntervalInHours: 8`).
 * An 8-hour undo on an irreplaceable corpus is the real exposure, and a readable second copy is the
 * cheap fix.
 *
 * `--dump` needs neither `--target` nor `--live`, so a backup run is a pure read: Cosmos in, a file
 * out, nothing sent anywhere. It composes with `--resume` and `--limit`, and appends rather than
 * truncates so a resumed run continues the same file.
 *
 * IT DUMPS `SELECT *`, NOT THE PUSH PROJECTION. The projection below exists to feed
 * `/ingest/eagle-chunks` and drops exactly the fields a RESTORE needs: `read[]`, without which
 * `repositories/chunks.js` throws "[chunks] every chunk requires a non-empty read[] ACL" on the
 * first batch, and `projectId`, the SCOPE_FIELD every scoped query filters on. Re-deriving either
 * means reading the `documents` container — in the same account this file exists to insure against
 * losing. A backup that needs the thing it is backing up is not a backup.
 *
 * WHERE TO PUT IT. Only `/home` survives on App Service, and DEMI is operated with stop/start
 * rather than restart, so anything outside `/home` is gone on the next stop. Write to
 * `/home/backups/chunks-YYYYMMDD.jsonl`, and treat the file as in-transit, not as the backup:
 * a copy that never leaves the container is not one. Pull it off with
 * `az webapp deploy --type static` in reverse, or read it over the same SSH tunnel the run uses.
 *
 * SIZE IT BEFORE YOU RUN IT rather than trusting a number in a comment: `--dump f --limit 10000`
 * writes 10k rows, then multiply by 113. `SELECT *` also carries the Cosmos system properties
 * (`_rid`, `_self`, `_etag`, `_attachments`, `_ts`), which `copy-to-env.js` already strips on the
 * way back in — several hundred MB across the corpus, and the reason a restore path exists at all.
 *
 * RESTORE, should it ever be needed: feed the file back through `src/scripts/copy-to-env.js`, which
 * already drops SYSTEM_PROPS before upsert. Nothing here writes to Cosmos, by design.
 */

const fs = require('fs');

const cosmos = require('../db/cosmos-nosql');

const CONTAINER = 'chunks';
const DEFAULT_BATCH = 1000;

function parseArgs(argv) {
  const args = { live: false, count: false, limit: Infinity, batch: DEFAULT_BATCH, target: '', key: '', resume: undefined, dump: '' };

  // `--dump --limit 3` used to produce a file literally named `--limit`, and a trailing bare
  // `--dump` produced `undefined` — which on a `--live` run means it pushes and silently takes no
  // backup, the exact run the flag exists for. Consume values through here so every option fails
  // loudly instead.
  let i = 0;
  const value = (flag) => {
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value, got ${v === undefined ? 'nothing' : `\`${v}\``}`);
    return v;
  };

  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (a === '--count') args.count = true;
    else if (a === '--target') args.target = value(a).replace(/\/$/, '');
    else if (a === '--key') args.key = value(a);
    else if (a === '--limit') args.limit = parseInt(value(a), 10);
    else if (a === '--batch') args.batch = parseInt(value(a), 10);
    else if (a === '--resume') args.resume = value(a);
    else if (a === '--dump') args.dump = value(a);
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

// Module scope so the catch at the bottom can flush it: process.exit() drops whatever is still
// buffered, and the rows lost that way are the ones nearest the failure.
let dumpStream = null;

/** How often to print a resumable checkpoint. Every page would drown the log; every 10 costs at most 10 pages of replay. */
const CHECKPOINT_EVERY = 10;

(async () => {
  const args = parseArgs(process.argv.slice(2));

  // --count returns before any page is read, so it can never write a dump. Say so rather than
  // exiting 0 with an empty file the operator believes is a backup.
  if (args.count && args.dump) {
    console.error('--count and --dump do nothing together: --count reads no pages');
    process.exit(1);
  }

  if (args.count) {
    const r = await cosmos.query(CONTAINER, { query: 'SELECT VALUE COUNT(1) FROM c', parameters: [] }, {});
    console.log(`chunks: ${r.items[0]}   (~${Math.round(r.requestCharge || 0)} RU)`);
    return;
  }

  // A --dump-only run pushes nothing, so it needs no destination. Requiring one would mean quoting
  // a live ingest key just to take a backup.
  if (!args.dump && (!args.target || !args.key)) {
    console.error('--target and --key are required (or use --dump for a backup-only run)');
    process.exit(1);
  }
  if (args.live && (!args.target || !args.key)) {
    console.error('--live needs --target and --key');
    process.exit(1);
  }

  // Append, never truncate: a resumed run continues the same file, and an accidental re-run cannot
  // erase the copy it was meant to protect.
  dumpStream = args.dump ? fs.createWriteStream(args.dump, { flags: 'a' }) : null;
  // Without this an ENOSPC arrives as an unhandled 'error' event and kills the process without the
  // script's own FAILED: line, which is the one place an operator would look.
  if (dumpStream) {
    dumpStream.on('error', (err) => {
      console.error(`FAILED: dump write to ${args.dump}: ${err.message}`);
      process.exit(1);
    });
  }
  if (dumpStream) console.log(`dumping every chunk read to ${args.dump} (append)`);
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
      // A dump run takes the WHOLE row — see the header. The push is unaffected either way because
      // pushBatch picks its fields explicitly rather than forwarding whatever arrived.
      { query: args.dump ? 'SELECT * FROM c' : SELECT, parameters: [] },
      { maxItemCount: args.batch, continuationToken: token }
    );
    token = page.continuationToken;
    ru += page.requestCharge || 0;
    pages++;
    if (page.items.length === 0) break;

    const slice = page.items.slice(0, Math.max(0, args.limit - read));
    read += slice.length;

    // Written from the page as READ, not from the push payload: this is a copy of the source of
    // record, so it keeps every selected field regardless of what eagle-search happens to accept.
    if (dumpStream && slice.length) {
      const ok = dumpStream.write(slice.map((c) => JSON.stringify(c)).join('\n') + '\n');
      // 1.13M rows outruns the default 16 KB buffer; without this the process grows until it dies.
      if (!ok) await new Promise((r) => dumpStream.once('drain', r));
    }

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

  if (dumpStream) {
    await new Promise((r) => dumpStream.end(r));
    console.log(`dump written: ${args.dump} (${fs.statSync(args.dump).size} bytes)`);
  }

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
})().catch(async (e) => {
  console.error('FAILED:', e.message);
  // Flush before exiting: append + --resume makes a short file recoverable, but only if the rows
  // that were already written actually reached disk.
  if (dumpStream) await new Promise((r) => dumpStream.end(r));
  process.exit(1);
});
