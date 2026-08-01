# DEMI — TODO

**Updated 2026-08-01.** Actionable work only. Rationale + measured facts in `MIGRATION.md`; agent
rules in `CLAUDE.md`. **Record finding once, in file that owns topic.**

Status: **dev only, no test/prod.** Items = backlog, not incidents.

---

## State of play

**Live.** Azure AI Search `demi-search-dev` (Basic, keyless, private endpoint only) serve all three
datasets — `demi-chunks` 80,354 rows, `demi-projects`, `demi-documents` 60,578 — indexers on
`PT5M`. Typesense deleted 2026-07-31, code and infrastructure both; `az containerapp list -g
c4b0a8-dev-rg` return nothing.

Cosmos counts read live 2026-08-01: **projects 2,248** (the 393 figure predate the NRPTI sync),
documents 60,578, records 48,086, boundaries 281. All three indexers report progress 100.

**Phase 8 deployed + verified live 2026-08-01.** Mongo-API layer gone from app. Clean week run to
**2026-08-08**; only Azure teardown left. Evidence in `MIGRATION.md` §B.

**Cost.** AI Search Basic fixed ~$75-81/mo whether queried or idle. `demi-budget-dev` window open
2026-08-01, so first real post-Typesense reading arrive then.

---

## Open work

### 1. Phase 8 Azure teardown — earliest 2026-08-08

Code side done. Nothing here run before the clean week end. Rollback until then is `git revert`, no
redeploy.

- [ ] Bicep: `azure/main.bicep:69` `cosmosDb` module + `:89` `mongodbConnectionString` wiring (its
      ONLY consumer) · `azure/modules/cosmos-db.bicep` · `api-web-app.bicep:22-24` param +
      `:113-129` settings block.
- [ ] Stale compiled `azure/main.json` — regenerate or delete. No workflow read it, but leaving it
      stale is a trap.
- [ ] App settings `MONGODB_URI`, `MONGODB_DATABASE` off `demi-api-dev`, then `stop`/`start`. **This
      burn the rollback.**
- [ ] Account `demi-mongo-dev-pcbd7cygyic52`, then `demi-mongo-pe` + its NIC. **The private endpoint
      is the only flat recurring charge (~$7/mo).**

Checked already, so nobody re-check:

- **`main.bicepparam` + three workflows need NO change.** `mongodbConnectionString` is an internal
  module param wired from a module output, never top-level, so the `typesenseApiKey` failure cannot
  repeat here.
- **`COSMOS_ENDPOINT` safe** — point at `demi-cosmos-dev`, the NoSQL account, not Mongo.
- **`main.bicep` is not what run** — no VNet in the RG, and it never instantiate the four modules
  that build current architecture. Settings come off with `az`, not a template deploy. Bicep edit
  keep the template honest for whenever IaC unblock.
- **`src/extract.js` still speak Mongo** and is deferred-not-dead. Guard added 2026-08-01: `main()`
  throw when no Mongo URI env configured, so a post-teardown run error instead of silently reading
  localhost and reporting zero documents.

### 2. Extraction RESTARTED 2026-08-01 — cascade recovered, run in flight

Halted 2026-07-30 14:08 after a crash cascade. Root cause fixed host-side, false failures recovered,
**full-corpus run restarted 2026-08-01 22:14 PDT** at `CONVERTERS=4` / `TEXT_WORKERS=8` on a host
resized to 64 GB / 16 vCPU. `LIMIT=0`, so this is the whole corpus.

First 90 minutes: **1,950 converted, 14 failed, 0 deferred, 0 runner faults**; 1,670 text path /
316 OCR (13 re-routed), ~1,350 docs/hr, **ETA ~42 h**. Every failure is `unsupported format: msg` —
genuine and permanent. RAM peaked 9 GB of 64, VRAM 8.4 GB of 16, so `CONVERTERS` has headroom if
the estimate needs to come down.

**The 7.4-day / 354-converter-hour figures in `MIGRATION.md` §A predate the router and are stale.**
Re-measure from this run when it lands rather than patching them by guess.

Both services are `systemctl enable`d, so a host reboot resumes. Work is resumable from disk —
`already_done()` reads `out/`, `sent/`, `dead/`, and `ingest.py` reruns every 5 minutes doing only
outstanding work.

**Root cause, confirmed by reproduction.** `ocr_worker` submitted `split_pdf` into a shared
`ProcessPoolExecutor`. A `ProcessPoolExecutor` never recovers — once a child dies badly, `_broken`
is set and every later submit raises. That raise hit a generic `except` which called `fail()`,
writing a `.err`, which `ingest.py` posts as `{"error": ...}`, which marks the document extracted
with zero chunks and removes it from the work list permanently. **One crash, 855 documents silently
absent from search.** Reproduced on the host's own Python 3.13: a killed pool child sets `_broken`
to the exact corpus string `A child process terminated abruptly, the process pool is not usable
anymore`.

**The count was wrong.** "~1,712" counted `.err` FILES across two directories, double-counting ids.
Deduplicated against what was actually posted: **855** documents recorded as errors.

| | | |
|---|---|---|
| Had good markdown already on disk | **842** | **recovered 2026-08-01** — 863 markdown files posted, 43,003 chunks, 0 failed, 2.2 min, zero GPU time |
| Crash victims with no markdown | **3** | 5 originally; 2 re-extracted in the 2026-08-01 smoke test |
| Genuinely unsupported (`msg`, `doc`) | **8** | correctly flagged, leave them |

**The remaining 3 need `purge-extraction.js --errors-only`** *if the host's `worklist.json` cache is
ever deleted*. `build_worklist` asks the API for `extracted=false`, so a document still flagged
extracted-with-error never appears in a REBUILD — but the cached list predates the flags and still
carries them, which is how the smoke test picked two up. Everything else the host requeues itself:
`ingestChunks` has no `contentExtracted` guard and a plain re-POST clears the error.

**Fixed host-side 2026-08-01** (out of repo, `worker.py`): runner faults are now classified apart
from document faults and `defer()`ed — no `.err`, so the document stays in the work list; the pool
is rebuilt in place; 25 consecutive runner faults stop the run rather than walking the corpus. The
circuit breaker exits **cleanly**, so `Restart=on-failure` deliberately does not restart it — it
stops and waits for a human instead of grinding through the corpus. The host now also sends
`extraction` provenance, which nothing ever had.

Sample for context, read live off the first 1,000 extracted documents in Cosmos scan order (783
carried an error, 777 of them the cascade string). `pageSize` caps at 1000 and the endpoint returns
a bare array with no continuation token, so that is **a page, not a total** — the signature was the
finding, not the 78% rate.

### 3. Extraction quality

Numbers + caveats in `MIGRATION.md` §A. **OCR not the problem: word-salad 0.23% of chunks, 30 of 40
randomly sampled documents had zero bad chunks.** In this order:

- [ ] **Slide decks extract to nothing but `<!-- image -->`.** Eight of sampled documents in index,
      unfindable by content. Find out whether router sent them down text path on a thin text layer,
      or whether OCR ran and returned nothing. Real defect; about coverage, not engine quality.
      **Wait for the run to land — provenance now arrives**, so this splits by `extraction.path`
      from data instead of needing the separate probe originally scoped. Note a thin text layer
      would still have emitted its words, so placeholder-only markdown already means docling
      extracted ZERO text; the live question is why zero.
- [ ] **Retrieval scoring** on human-labelled phrases — the verdict metric. Heuristics cannot see
      character-spacing damage (`Tum ble r Ridge` score clean), so only this close the question.
- [ ] Only then decide on an intake cleaner. On current evidence job small: strip `<!-- image -->`,
      drop chunks that are pure separator furniture. **Not** an OCR re-run.

### 4. Needs a human, not code

- **AI Services Hub registration.** Platform documents that *"Provisioning Azure AI services is
  managed through the AI Services Hub in the Landing Zones"*, requested via
  <https://bcgov.github.io/ai-hub-tracking/>. `demi-search-dev` created directly, without that
  request. Nothing blocked it, nothing broken, but process skipped — submit before this go past dev.
- **Provenance from LXC 109 (`doc-ocr-processor`).** API accept an `extraction` object now, but the
  host must send it. Until then, no quality number splittable by OCR path vs text-layer path.
- **`rg-epic-search` (test subscription)** — not ours. `Standard_E32-16ads_v5` VM **deallocated**,
  but `vm-postgresql-vector` (`Standard_D8s_v3`) **running**, alongside three App Services, three
  plans, App Gateway WAF policy, Log Analytics, storage. Someone confirm owner + bill.

---

## Backlog

- **`wwwroot` debris.** Twelve ad-hoc probe scripts at the root of the deployed app —
  `_auditwrap.js`, `_copy.js`, `_copy.log`, `_derive.js`, `_fetch.js`, `_fts.js`, `_idx.js`,
  `_isolate.js`, `_meta.js`, `_param.js`, `_purgewrap.js`, `_syncwrap.js` — plus an empty
  `src/models/`. None in the repo, none reachable as routes, but `config-zip` merge never remove
  them. Clean out through Kudu VFS.
- **Nothing in Azure extracts text.** Ingest exists (external host POST markdown to
  `POST /documents/:id/chunks`); `src/extract.js` run only under `require.main === module`.
  Deliberate — serverless GPU priced and rejected. **Do not delete as dead code.**
- **CI blocked.** `AZURE_CLIENT_ID` missing from repo secrets. Need Entra app registration +
  federated credential; creating one need Microsoft Graph, which conditional access block.
- **`azure-deploy-prod.yaml` / `-test.yaml` trigger on every push to `main`** — no tag, no approval.
  Inert today. **Gate before adding the OIDC credential.**
- **Phase 3b blob storage** — code + Bicep written, not deployed, nothing copied. Need
  `Storage Blob Delegator` or every download link fail to sign.
- **`syncState` container** exist in `cosmos-nosql.bicep`, unwritten by anything.
- [ ] Verify every `README.md` claim against the running system.

---

## Open decisions

| # | Question | Default | Cost of reversing |
|---|---|---|---|
| 1 | Backup mode `Continuous7Days` on dev | Not done | **One-way.** Gain 8h/support-ticket → 7-day self-service, free tier; lose Geo backup redundancy permanently |

Settled, kept only because reversing them is expensive: **index tier** (Basic, `content`
`retrievable: false` — Basic→S1 need a **new service + full reindex**) and **delete propagation**
(hard delete + immediate index delete; the `_ts` high-water mark seeing no deletes is measured, not
assumed).
