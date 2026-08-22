# TODO

Open work only. Facts, measurements and history live in the
[wiki](https://github.com/digitalspace/eagle-demi/wiki); if something here needs a paragraph of
background, that background belongs there and this entry links to it.

Staging deploys itself: a merge to `main` runs `azure-deploy-staging-api` and
`azure-deploy-staging-frontend` against `demi-*-test`, so what is on `main` is what is on staging
within a few minutes. Prod is dispatch-only from a published tag
(`azure-deploy-prod.yaml`), and only the extractor half has a target today. There is no date or
commit to keep current here — read the workflow runs.
This paragraph used to name the deployed SHAs anyway, and they were stale within a day; a pointer
that has to be maintained by hand is the drift the sentence before it warns about.

The corollary is the trap: **merging is deploying.** An entry below is live the moment it lands.

---

## What is actually open

The sections below are grouped by topic, which makes a blocked item read like an actionable one.
Nothing here is a separate list to maintain — it says which gate each open entry is waiting on, so
"what can I do right now" does not require reading all of it.

| Gate | Open entries waiting on it |
|---|---|
| **Nothing — do it** | Rotate the MinIO key and OpenShift token at source (the repo side is already deleted); deploy the Bicep index changes (the boundary ACL needs no backfill — see the audit) |
| **A dev run + `az login`** | Minting the first real service key — **and it is now the only way to test the ACL against anything**, because every row in dev is public; the NRPTI re-sync design |
| **RG-scope rights nobody holds yet** | Observability / `APPLICATIONINSIGHTS_CONNECTION_STRING`; the first `main.bicep` deploy; removing role assignment `29745ac3`; Phase 3b blob storage |
| **A human in a browser, staff login** | The `/summary` render; boundary rendering at three fidelities; server-side highlighting; the scoped access tier |
| **A decision, not work** | Required reviewers on the `prod` environment; app registration `acb4198f`; whether `GET /projects` may narrow its payload; dropping the dead `logs`/`leases` containers |
| **Deliberately not doing it** | `pageNumber` citations; result paging; the client-side highlighter; the intake-cleaner backfill; the OnPush conversion; natural-language labels; the tiled/OCR strata; the 402 monthly rollover; `content: retrievable` |

**Before hardening, read this one first:** nothing DEMI logs is retained anywhere, so every "the
reason is logged" claim in this file means the App Service log stream — visible only to someone
already watching, and gone after. That is the observability entry under Infrastructure, and it
outranks the rest of a hardening pass for the obvious reason: you cannot harden what you cannot
observe. It is also the entry with the least code in it and the most permission.

**Still uncovered by `test/helpers/access-coverage.test.js`, and the reason a behavioural suite
may earn its place later:** OData has no `false` literal, so a null or empty filter is
UNRESTRICTED. A search route that forgets the `empty` flag fails **open**, and a structural scan
cannot see that — it would see `filterFor` being called and be satisfied.

---

## Label debt

The retrieval scorecard is the verdict metric for extraction quality. It now rests on 78 labels
across five strata, all of them verified by a human reading the source rather than seeded from
metadata.

- [ ] **The tiled stratum has 9 labels and no more renders to read.** The seven renders in
      `/root/demi-tiled-review/` were read by eye on 2026-08-04 and labelled; going past 9 means
      rendering more map sheets from the object store, where ~1,496 source PDFs 404.
- [ ] **No OCR-scan stratum exists.** `retrieval-labels-ocr.jsonl` was deleted rather than scored:
      its 25 lines were seeded from document TITLES, which are metadata and were never verified to
      be on the page, and 13 were marked STARVED. Rebuilding it needs renders of scans that mostly
      cannot be fetched. `B-ocr-legacy` and `C-ocr-pdfium` still cover the OCR paths.

Pooled recall@10 is 0.590 at n=78 (recall@1 0.308, MRR 0.392). One standard error is ~0.056, so it
is the same number as the 0.620 recorded at n=71 — the labels moved, the retrieval did not.

## Retrieval — the ranking failure is fixed

Closed 2026-08-05. It was a ranking problem, and a reranker fixed it.
`58869332de49fe015163a0c9` ("CROSS SECTIONS N AND A THROUGH NORTH WASTE DUMPS") ranked **11** under
BM25 and ranks **2** with semantic reranking on. Paired run, 78 labels, one session:

| | recall@1 | recall@10 | recall@50 | MRR |
|---|---|---|---|---|
| BM25 | 0.308 | 0.590 | 0.705 | 0.398 |
| + semantic ranker | **0.372** | **0.628** | 0.705 | **0.472** |

5 miss→hit and 2 hit→miss at k=10; 23 labels moved up, 7 down, 25 unchanged. `found@50` is
identical at 55 in both arms — the check that L1 was untouched, since a reranker can only reorder
what BM25 already retrieved. The textless control stays 0 in both arms.

Honest limit: 5 versus 2 discordant pairs is not significant on its own (one SE ~0.056). The case
is that all three metrics move together with nothing regressing — the bar `FUZZY_BOOST` cleared and
`anyTerms` failed. Scorecards in `src/scripts/scorecards/2026-08-05-*`.

- [ ] **Nothing measures this for natural-language queries.** All 78 labels are verbatim phrases
      lifted off a page, which is exact-match lexical retrieval — the weakest case for a reranker
      trained on natural language. It won anyway. But the queries real users type are the case the
      feature is actually for, and no label set covers them; there is no query log to build one from
      because nobody uses DEMI yet. The gain above is a floor, not an estimate.

## Extraction

- [ ] **`pageNumber` is a citation feature and nothing cites. Do not build it yet.** It is a sequence
      number on both paths, not a PDF page, and making it real needs host, wire-protocol and API
      changes *plus* re-extraction — it does not ride a re-chunk. Nothing consumes it: no PDF viewer
      and no `#page=` anchor in the frontend, which renders it honestly as `Passage N`. If citations
      are ever wanted, the cheap slice is the text path (56% of the corpus, pypdfium2, no GPU), but it
      still needs source PDFs and ~1,496 already 404 in the dev object store. Whether a browser
      honours `#page=N` on a presigned URL depends on the object being served inline rather than as an
      attachment, which is unverified. Background:
      [Extraction Pipeline](https://github.com/digitalspace/eagle-demi/wiki/Extraction-Pipeline).
- [ ] **The intake cleaner is intake-only.** Chunks already written keep their `<!-- image -->`
      placeholders and their separator-furniture rows; only new ingest is clean. Nothing here is
      worth a re-extraction on its own — fold it into whatever re-extraction happens next.

## NRPTI ingest — REMOVED 2026-08-07, to be redesigned

**The whole feature is gone**, not disabled: `sync-nrpti.js`, `purge-nrpti-seeded.js`, the `records`
container and its repository, `GET /records`, `POST /admin/sync/nrpti`, the seeder's records stage,
the compliance card in the frontend, and the `project_fragments` container that existed only to hold
the NRPTI aggregate. Restore any of it from `28737bf`.

It was removed rather than narrowed because the scope rule had never been written down, so each pass
re-derived intent from the code. **The rule: only projects EAO and NRPTI actually share matter, and
the link between them is the eagle project id** (`_epicProjectId` on an NRPTI record, matched against
`eagleId` on ours). The five-strategy linking ladder went far beyond that — exact name, normalized
name, last-segment split, token inclusion — and its fuzzy tail is what turned region names into
projects. `British Columbia` alone became one phantom project holding 49,459 compliance records;
1,855 phantoms had to be purged on 2026-08-07.

### What was measured before deleting — start the redesign here, not from scratch

Live census against `nrpti-api-f00029-prod`, 2026-08-07, against dev's 382 projects (354 carrying an
eagle id). "Shared" means `_epicProjectId` resolves to one of ours:

| Dataset | Upstream | On shared projects |
|---|---|---|
| Inspection | 67,298 | 1,466 |
| Order | 1,086 | 157 |
| AdministrativePenalty | 897 | 4 |
| AdministrativeSanction | 4,582 | **0** |
| CourtConviction | 1,018 | **0** |
| RestorativeJustice | 9 | **0** |

- **The fuzzy ladder bought almost nothing.** Records matching only by exact name, with no valid
  `_epicProjectId`: **1** in Order, **14** in Inspection. It was risking wrong-project writes — which
  are invisible once written — to gain fifteen rows.
- **Three datasets never link at all.** Any redesign should fetch by dataset rather than sweeping all
  fourteen; Ticket (29,555) and AdministrativeSanction (4,582) cost most of the sync's runtime and
  produced nothing.
- **`?populate=true` works, and the old code did not know it.** The deleted seeder asserted NRPTI's
  document ids were unreachable — "nothing for `dataset=Document`, 404 for `/api/public/document/<id>`".
  True as written, and beside the point: adding `&populate=true` to the ordinary search call returns
  full document objects inline (`{_id, fileName, url, key, read[]}`) instead of bare ObjectIds.
- **The documents are mostly already here.** Document URLs on shared projects are overwhelmingly
  `projects.eao.gov.bc.ca/api/document/<eagle-doc-id>/fetch`, and DEMI's `documents` container is
  keyed by that same eagle doc id. Sampling 25 of them against dev: **22 already in DEMI, already
  extracted and chunked; 3 missing.** A future import is therefore mostly a LINKING problem — parse
  the id, point at what we hold — not a download pipeline. Note this is the picture for EAO-issued
  records; across the whole corpus most document URLs sit on `nrs.objectstore.gov.bc.ca` instead,
  and those belong to records that do not link to us anyway.

### The live containers are dropped too, 2026-08-07

ARM does not drop a container when the template stops declaring it, so the merge left `records`
(~3,556 rows) and `project_fragments` (empty) standing on dev. Both were deleted by hand the same
day with `az cosmosdb sql container delete`, and **`az cosmosdb sql container list` now returns the
same eight names the Bicep declares** — no drift in either direction, so no reconciling deploy is
needed. PITR is `Continuous7Days`, which makes both restorable until roughly **2026-08-14**.

Two notes for whoever runs the next container deletion here:

- **The Azure MCP cannot do it, and cannot even read this account.** Its `cosmos` commands are all
  reads and they route to the DATA plane (`demi-cosmos-dev.documents.azure.com`), which is
  private-endpoint-only — so they answer `403 ... blocked by your Cosmos DB account firewall` from
  outside the VNet. Its `arm` commands have no DELETE at all, and deployments are restricted to
  `mode: Incremental`, which never removes a resource. Only `az` reaches the control plane.
- **Still carried, deliberately:** ~191 projects hold a stale `sources.nrpti` block written by the
  deleted `patchNrptiStats`. Nothing reads it — the API never projected it and the frontend model no
  longer declares it — and clearing it needs an SSH tunnel plus a bespoke patch script, since the
  script that could have done it is what was deleted. Not worth writing code against a live database
  for a few hundred bytes of dead JSON.

## API audit — 2026-08-07

Cleanliness, search efficiency, scalability and security, plus a live anonymous probe of every read
endpoint on dev. **The access model held.** 382 projects and 1,000 documents fetched with no
credential returned **zero** rows failing the `read[]`-contains-`public` / `isPublished` test; all
three search datasets likewise; every privileged endpoint and all 15 write routes answered 401. A
nonsense keyword returned 0 hits on all three datasets, which is the discriminator that AI Search is
actually serving rather than silently falling back to Cosmos.

### Not done, deliberately

- [ ] **`GET /projects` ships 2.32 MB for 382 projects** — measured. `sources.*` is **65.8%** of it
      (1.5 MB of raw upstream Track/Eagle payloads), against a frontend that reads only
      `sources.wildfire`. The obvious fix is a projection, and it is NOT applied because **nothing in
      this repo calls `GET /projects`** — the frontend goes through `/api/search?dataset=Project`.
      That makes it a public API contract with no in-repo consumer to validate a narrowing against,
      so the change belongs with a named consumer, not with an audit.
      Near-miss worth recording: the same instinct applied to `GET /boundaries` nearly shipped a
      regression. Defaulting geometry to opt-IN looks obviously right and is wrong — the frontend
      sends `geometry=simplified` and the bbox path sends nothing at all, so both would have lost
      their polygons silently. Geometry stays opt-OUT.
- [ ] **Cosmos-fallback search pages truncate at 1000 with no continuation token**, so a client
      cannot ask for more (`controllers/search.js`). Only reachable when AI Search faults.
- [ ] **`logs` and `leases` containers are entirely dead** — the log transport and `GET /admin/logs`
      were removed, and nothing reads leases. `leases` has no indexing policy at all, so Cosmos
      indexes every path. Dropping them is a live-data decision, and removing them from the Bicep
      would NOT drop them (ARM does not delete on template removal) — it would only create drift.
- [ ] **`wildfires` indexing is pure write amplification**: a spatial index on `/location/*` and
      three included paths serving no query at all — proximity is computed in JavaScript, never via
      `ST_DISTANCE`. Same for the unused `projects` composite index and the `/trackProjectId`,
      `/updatedAt`, `/fileExt`, `/displayName`, `/code` paths.
- [ ] **Search fan-out is 7 AI Search calls + 3 cross-partition Cosmos queries per debounced
      keystroke** (three datasets in parallel), on a single-worker B1. `/search/summary` is 12 round
      trips worst case. Bounded and measured, not a bug — but it is the first thing to look at if
      search latency becomes a complaint.
- [ ] **The ACL array is returned to anonymous callers**, so the role taxonomy is public. Disclosure,
      not bypass; it disappears with the projection above.

### Azure AI Search — audited 2026-08-07

Same four lenses as the API audit above. **The read path is sound**, and the honest caveat is
bigger than any finding: see "the probe that cannot fail".

**Verified correct:**

- **All four `filterFor` call sites honour the `empty` flag** — the fail-open shape. `DocumentChunk`
  short-circuits and issues no request; `Project` and `Document` fall through to Cosmos instead,
  which is safe by a *different* mechanism: SQL has a `false` literal, so scoped-to-nothing is
  expressible there. `/search/summary` short-circuits too.
- **The document fan-out's second leg re-applies the caller's filter** —
  `(${opts.filter}) and search.in(projectId, …)`. Visibility of a project never widens access to its
  documents, it only decides which ids are worth asking about. When the project filter is `empty`,
  leg two is skipped entirely rather than run unfiltered.
- **No OData injection reachable from a caller.** Keywords go through `tokenize`, which strips
  Lucene operator characters; role values come from a verified token and are quote-escaped by
  doubling. Probed live with `') or read/any(r: r eq 'sysadmin`, `' or true or '`, `*` and an
  `isPublished eq false` payload — every one returned 0 or public-only hits.
- **A caller cannot name its own roles or scope.** `?roles=sysadmin`, `?access=privileged` and the
  `x-roles` / `x-user-roles` / forged `authorization` headers all changed nothing.
- **Chunk text never leaves the API.** `content` is absent from every hit; the response carries a
  `snippet` built escape-first, mark-second.
- **Service posture, verified live**: Basic, 1 replica / 1 partition, `disableLocalAuth: true`
  (keyless, managed identity), `publicNetworkAccess: Disabled`.

#### The probe that cannot fail

**An anonymous caller sees 60,578 documents over 61 pages — the entire seeded corpus.** Every
document in dev is public. So the search ACL currently withholds **nothing**, and *no live probe
against this corpus can fail*: the earlier "zero non-public rows across every dataset" result proves
the filter does not BREAK anything, not that it PROTECTS anything. This is the trap this repo keeps
writing down, and it applies to the search audit as much as the API one.

The only discriminating evidence is synthetic: the unit tests added alongside this entry, which
assert a scoped-to-nothing caller issues no request on all three datasets, and that a scoped
*privileged* caller's filter still carries `search.in(projectId, '207')` with the role clause
lifted. Those fail if the gate regresses. A live probe would not.

#### Findings

- [ ] **`content` is `retrievable: true` on `demi-chunks`.** The only thing keeping whole chunk text
      out of API responses is the explicit `select` list in `searchChunks` (pinned by a test).
      Nothing reads `content` from the index — the summariser reads it from Cosmos, which is the
      N+1 at `controllers/search.js`. `retrievable: false` would make the guarantee structural
      rather than conventional. Not changed here because highlighting also reads that field and the
      interaction cannot be tested from outside the VNet.
- [ ] **Deletes are permanently the application's job.** `dataDeletionDetectionPolicy` is `null` on
      all three datasources, so a removed row stays searchable until `deleteFromIndex` /
      `deleteChunksForDocument` is called. Already wired into `deleteProject`/`deleteDocument`; the
      obligation never goes away, and it is invisible in the indexer config.
- [ ] **No index-level paging.** `$skip` is never sent and `top` is clamped to 250, so a result set
      past the first page is unreachable rather than slow.
- [ ] **The semantic 402 latch never resets.** `semanticExhausted` is process-wide with no month
      rollover, so a single 402 degrades every later search in that worker to BM25 until it recycles.
- [ ] **Boundaries have no search surface at all** — no index, no datasource, no indexer. The ACL
      added to that container therefore has nothing to keep in sync, which is worth knowing before
      anyone adds one: an indexed boundary would need `read[]` in the index and the same filter
      treatment as documents, or the restriction would hold in the API and not in search.

## The action list — 2026-08-07

Everything the two audits left open, ordered by what it costs to get wrong rather than by effort.
Each line says what to do, why it matters, and what would prove it worked. Items already fixed are
in the audit sections above; this is only what is still outstanding.

### 0. Incident, 2026-08-13 — two credentials destroyed, and what actually protected us

`ADMIN_API_KEY` and `DOCLING_API_KEY` were overwritten on `demi-api-test` by a deployment run with
throwaway test values. The chain: `siteConfig.appSettings` is a whole-collection PUT, an
`ADMIN_API_KEY=" "` abort-path test was let through by a `[ -z ]` check that treats a space as
non-empty, and the deploy did exactly what it is built to do.

**Neither value was recoverable from Azure.** ARM does not retain `@secure()` parameters — the prior
successful deployment returns `{"type":"SecureString"}` and nothing else. MinIO survived the same
event only because OpenShift held an authoritative copy, and `ADMIN_API_KEY` was recovered only
because the GPU extraction host had its own copy in `gpu-extractor.env`.

What changed as a result:

- `demi-app-secrets` in `6cdc9e-test` now holds both keys. **OpenShift is the source of truth for
  every credential the template deploys**, and `scripts/deploy-infra.sh` reads from there.
- The script no longer round-trips secrets out of the live app settings. Reading the app you are
  about to deploy feeds a corrupted value back into itself — that loop is what turned a one-
  character mistake into a permanent loss.
- Its guard trims whitespace and rejects anything under 8 characters, not merely empty.

`ADMIN_API_KEY` is now the GPU host's 48-char key rather than the previous 64-char value, which no
surviving system held. `DOCLING_API_KEY` was regenerated freely: it is outbound-only to
docling-serve, `src/extract.js` has no production caller, and `DOCLING_URL` is set by no template,
so **nothing consumes it today** — its value is arbitrary until extraction-in-Azure is revived, at
which point docling-serve's side is set from the same value.

- [ ] **Rotate `ADMIN_API_KEY` deliberately, at a time of your choosing.** It is working and
      consistent across DEMI and the GPU host, but its value passed through an incident. Rotation
      means: new value into `demi-app-secrets`, `gpu-extractor.env` on the GPU box, and the App
      Service — then restart `gpu-extractor` and `gpu-ingest`.

### 1. Do next — cheap, and something is wrong until they are done

- [ ] **Deploy the Bicep index changes.** Narrowed on 2026-08-13 by the first `main.bicep` apply:
      `chunks /isPublished` is already live, and `documents /id` and `boundaries /id` turned out to
      be undeployable by construction — Cosmos rejects `/id` in an indexing policy because it is a
      system property that is always indexed, so the by-id fallback those lines were meant to serve
      was never scanning in the first place. Both were removed from the template.
      What is genuinely still missing is the boundary `read[]`/`isPublished` pair, which does scan
      on every anonymous map load. **Proof:** `az cosmosdb sql container show -n boundaries` lists
      `/read/[]/?` and `/isPublished/?`.
- [ ] **Mint the first real service key.** It is on the list twice over now: it is the only way to
      exercise the ACL against anything, because **every row in dev is public**, so no live probe of
      the read path can fail. **Proof:** a key with `roles:['staff'], projectScope:['<id>']` returns
      only that project — the case that used to return the whole corpus.
- [ ] **Rotate the MinIO key and OpenShift token at source.** The repo side is already deleted; the
      credentials themselves are still live. Oldest open item in this file.

### 1b. The project ceiling — next change, designed and decided

- [ ] **Unpublishing a project cascades to nothing.** `resolveDocumentAcl` checks the parent when a
      document is WRITTEN (`published = requested && parentIsPublic`) and nothing re-evaluates it, so
      a project unpublished afterwards leaves its documents carrying `read: ['public']` — still
      listable, still downloadable. No chunks needed to leak.
      **Documents within a project carry independent visibility**, so a blanket cascade is wrong in
      the other direction: it would make re-publishing a project blanket-publish every document
      someone had deliberately restricted, unrecoverably.
      **Decided approach — denormalise `projectIsPublished` onto documents**, the pattern the
      workspace already uses on Typesense `document_chunks`. The project becomes a real ceiling and
      no document's own `read[]` is ever touched: `visible = read[] matches AND (projectIsPublished
      OR privileged)`. On a project publish change, bulk-Patch that ONE field across its documents —
      single-partition on `/projectId`, ~80 requests for the largest project. Chunks need nothing,
      because the search gate now derives them from the parent document.
      Needs: the predicate option (alongside `unsetIsPublic`), `/projectIsPublished/?` in the Cosmos
      index, the field on `demi-documents` + its datasource + `access-odata.js`, and a backfill of
      ~60,578 rows.
      **Ordering trap:** `c.projectIsPublished = true` against an undefined field is NOT true, so
      shipping the predicate before the backfill makes every document vanish — the same shape that
      nearly blanked the map with the boundary ACL. Backfill first, or ship
      `(NOT IS_DEFINED(c.projectIsPublished) OR c.projectIsPublished = true)` and tighten after.

### 2. Decisions, not work — nobody can proceed until someone chooses

- [ ] **May `GET /projects` narrow its payload?** 2.32 MB for 382 projects, 65.8% of it raw upstream
      `sources.*` that no in-repo caller reads. Nothing in this repo calls the endpoint at all, so
      the question is entirely about external consumers. If there are none, this is a one-line
      projection.
- [ ] **Drop the dead `logs` and `leases` containers?** Nothing reads or writes either; `leases` has
      no indexing policy so Cosmos indexes every path it is given. Removing them from the Bicep does
      NOT delete them — that is a hand-run `az cosmosdb sql container delete`, and the template
      change alone would only create drift.

### 3. Hardening — real, none urgent

- [ ] **`content: retrievable: false` on `demi-chunks`.** Today the only thing keeping whole chunk
      text out of responses is an explicit `select` list. Nothing reads `content` from the index.
      **Blocked on:** confirming highlighting still works, which cannot be tested from outside the
      VNet. Do it with the first in-VNet session.
- [ ] **Reset the semantic 402 latch at month rollover.** One 402 currently degrades every later
      search in that worker to BM25 until it recycles.
- [ ] **Return a continuation token on the Cosmos-fallback search paths**, or state the truncation.
      A page silently stops at 1000 with no way to ask for more. Only reachable when AI Search
      faults, which is why it is here and not above.
- [ ] **Strip the index paths that serve no query**: the `wildfires` spatial index on `/location/*`
      (proximity is computed in JavaScript, never `ST_DISTANCE`), the unused `projects` composite,
      and `/trackProjectId`, `/updatedAt`, `/fileExt`, `/displayName`, `/code`. Pure write
      amplification. Bundle with any other Bicep deploy rather than doing it for its own sake.

### 4. Known ceilings — written down so they are not rediscovered

- **Every row in dev is public.** 60,578 of 60,578 documents are visible anonymously, so the ACL
  withholds nothing and no live probe can fail. Only synthetic tests discriminate. This is the
  single most important caveat on both audits.
- **Search fan-out**: up to 7 AI Search calls + 3 cross-partition Cosmos queries per debounced
  keystroke; `/search/summary` is 12 round trips. Bounded and measured, on a single-worker B1.
- **AI Search deletes are permanently the application's job** — `dataDeletionDetectionPolicy` is
  null on all three datasources.
- **Swagger documents 6 of 28 routes** and advertises an `ApiKeyAuth` scheme that is not enforced,
  on an unauthenticated `/api-docs`. Misleading rather than dangerous; writing 22 stubs is not worth
  it until something consumes the spec.
- **Observability is still the ranked blocker.** Nothing DEMI logs is retained, so every "the reason
  is logged" claim in this file means the App Service log stream — visible only to someone already
  watching, and gone after.

---

## Infrastructure

- [ ] **Every component now declares `ChangeDetectionStrategy.Eager`, and the lint rule that says so
      is switched off.** v22 makes OnPush the default and its migration wrote the explicit opt-out on
      all five components to preserve v19 behaviour; `@angular-eslint/prefer-on-push-component-
      change-detection` then failed the build, so it is disabled in `frontend/eslint.config.js` with
      the reason. Only map-explorer and summarizer hold local signals — the rest read service signals
      and mutate plain fields from async callbacks, which OnPush would stop rendering, and the two
      spec files would not catch it. Converting them is a change-detection rewrite with its own
      verification; re-enable the rule when it happens.
- [ ] **Prod deploy path is built, but has nothing to deploy the API to.**
      `.github/workflows/azure-deploy-prod.yaml` exists — `workflow_dispatch` with a `version`,
      checking out `refs/tags/<version>`, both jobs on `environment: prod`. What is still open:
      `demi-api-prod` does not exist (the API job skips on a probe), and the required-reviewers
      decision on the `prod` environment has not been taken.
- [ ] **App registration `acb4198f-64db-4485-9638-a894e2d2c99b` — KEPT deliberately, not for CI.**
      Left from the app-registration route before `demi-cicd-dev` superseded it. Not deleted: app
      registrations are hard to provision in this tenant, and human federated sign-in is precisely
      what the landing zone says they are for. It holds no role assignment, so it grants nothing
      today. It DOES still carry the GitHub Actions federated credential `github-eagle-demi-main`
      (subject `repo:digitalspace/eagle-demi:ref:refs/heads/main`) — dormant while the app has no
      permissions, live the moment it gets any, from a PUBLIC repo. Settle that before wiring this
      app to sign-in.
- [ ] **The unreferenced repo secrets are DELETED; rotating them at source is the open half.**
      `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `TYPESENSE_API_KEY`, `OPENSHIFT_TOKEN` and
      `OPENSHIFT_URL` were live credentials in a **public** repo's settings, reachable by any
      workflow that asked. The two `MINIO_*` were read only by the deleted test/prod workflows, as
      Bicep parameters; `TYPESENSE_API_KEY` outlived Typesense (deleted 2026-07-31) and
      `OPENSHIFT_*` predate the move off OpenShift entirely.
      Deletion verified 2026-08-07, not assumed: `/actions/secrets`, `/actions/variables` and
      `/dependabot/secrets` each report `total_count: 0`.
      **That ends the exposure going forward, not the exposure that already happened**, which is why
      this entry stays open rather than closing on the delete. A credential that sat in a public
      repo's settings should be treated as one that may have been read, and nothing checkable from
      here can show it was not. What is left needs whoever owns those systems: rotate the MinIO key
      at `nrs.objectstore.gov.bc.ca` and retire the OpenShift token at its issuer.
      `TYPESENSE_API_KEY` needs nothing — the service is gone.
      MinIO itself is still in use at runtime; those values come from Azure app settings, not here.
- [ ] **`demi-identity-dev` briefly held Website Contributor on `demi-api-dev`** (assignment
      `29745ac3`, 2026-08-05, removed same day). Worth knowing that
      `Microsoft.Authorization/roleAssignments/delete` is denied at this RG even though *create*
      succeeds — the `permissions` API reports `actions: ["*"]`, `notActions: []`, which is
      misleading. Removing a role assignment needs someone with more rights.
- [ ] **Phase 3b, blob storage.** Code and Bicep written, nothing deployed or copied; wired into
      `main.bicep` behind `deployDocumentStorage`, which defaults false. The argument is
      per-environment isolation, not cost. Needs `Storage Blob Delegator` on the identity or every
      download link fails to sign — it is not implied by `Storage Blob Data Contributor`.

## Semantic ranker — two things to watch, now that it is live

- [ ] **`content` is `retrievable: true` and the index no longer stops whole chunks leaving.**
      Semantic configuration fields must be searchable *and* retrievable, so it had to flip. The
      guarantee now lives in `searchChunks`'s explicit `select` list, which excludes `content` —
      adding it there is not a display tweak, it starts returning full chunk text to every caller.
      Verified on the live index that L2 still reads the field with `select` excluding it, so
      nothing else had to change. **The watch is a test, not a habit** —
      `test/search/ai-search.test.js:226` asserts `!body.select.includes('content')`, so adding it
      back fails CI rather than quietly shipping chunk text. Left open only because the index
      setting itself is still the permissive one.
- [ ] **Prod logs go nowhere. In staging this is fixed; the history below is `demi-api-dev`.** Measured
      2026-08-06: `api/index.js` starts the Azure Monitor OpenTelemetry distro only
      `if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING)`, and `demi-api-dev` has no such app
      setting. Nor could it have a working one — `az group resource list` on `c4b0a8-dev-rg` shows
      neither `demi-logs-dev` nor `demi-insights-dev`. The portal-created orphan
      `workspace-c4b0a8devrgYb8e` that `azure/modules/observability.bicep` was written to replace is
      **deleted** (2026-08-07) — it had ingested zero rows and no diagnostic setting anywhere pointed
      at it, so it was never going to become the pipeline. The two `setByPolicy-LogAnalytics`
      settings on Cosmos and AI Search go to the landing zone's own
      `bcgov-managed-lz-live-la` in a different subscription; platform telemetry, not ours, and not
      queryable as an app log. That module deployed for the first time on 2026-08-13, in the same
      apply that first ran `main.bicep`.
      So every "the reason is logged" claim in this file means "written to the App Service log
      stream", which is visible only to somebody already watching, and gone after. That is the exact
      failure `observability.bicep`'s own header describes, and it is why the ranking entry above had
      to become counters on an endpoint rather than an alert rule on a log line.
      **STAGING IS FIXED, 2026-08-13.** `observability.bicep` deployed and `demi-api-test` now
      carries `APPLICATIONINSIGHTS_CONNECTION_STRING` — verified on the live app 2026-08-20 — so the
      distro does start there and the paragraphs above describe `demi-api-dev`, which no longer
      exists. What is still open is prod: there is no `demi-api-prod` to set it on, and no
      observability resources in `c4b0a8-prod`.
- [ ] **The 402 latch does not un-latch when the month rolls over.** A single 402 turns semantic off
      for the life of the process, which is what stops every later search paying a wasted 402 plus a
      retry. But the allowance resets monthly and the latch does not, so a process that spans the
      rollover keeps serving BM25 until it restarts. Fine today — App Service recycles well inside a
      month — and the trade is deliberate: the alternative is re-probing on some timer nobody would
      tune. If the app ever gets long-lived, restart it after a 402 rather than waiting.

## Search UI

- [ ] **There is no result paging.** `searchChunks` sends only `top` (default 20, hard cap 250) and
      never sends `$skip`; the controller has no offset and the frontend has no load-more. Left alone
      deliberately — nobody uses DEMI yet, and this is a decision for whoever owns the search UI. If
      it is ever wanted: `$skip` caps at 100,000 and deep skips degrade, and score-ordered paging is
      unstable across requests, so infinite scroll needs a deterministic tiebreak in `$orderby` rather
      than score alone. `@odata.count` is already requested and returned by all three datasets and
      shown in the column headers — so the user can see how much a page is hiding, which is the
      argument for paging rather than a substitute for it.
- [ ] **The client-side highlighter did not die and should not yet.** Project, document and chunk
      cards now render the analyzer's own `<mark>` markup, but the regex-and-Levenshtein path still
      backs two live cases: results from the Cosmos fallback, which has no analyzer to ask, and
      map-explorer's boundary-name lists, which never touch the search API. It becomes deletable
      only if the Cosmos fallback goes.

## Needs a human, not code

- [ ] **See the summariser in a browser.** `demi-foundry-dev` is deployed and `GET /api/search/summary`
      returns grounded summaries with citations, usage and cost (verified 2026-08-05 with an
      `X-Api-Key`). The `/summary` page is in the deployed frontend bundle, but every route into it
      needs a staff Keycloak login, so the rendering — answer card, sources list, `est. $…` line —
      has not been seen. Log in on
      https://demi-frontend-test-eaa9cyfydsb0ejet.a02.azurefd.net/summary and look.
- [ ] **Verify the scoped access tier end to end.** The reason this was never observed is
      now known and fixed: `helpers/auth.js` rejected any non-privileged Keycloak token inside
      *authentication*, so `passiveAuth` dropped it and `req.user` stayed unset — TIER.SCOPED was
      unreachable in production regardless of the role. Fixed in PR #15 (`b7d61ae`) and
      regression-tested. What remains is genuinely human: create a `project:<id>` role on a test
      user and confirm the filter narrows against real data.
- [ ] **Verify boundary rendering at all three frontend fidelities.** The API contract is verified
      (`/boundaries` and `/boundaries/<name>` both 200); the visual result is not.
- [ ] **Look at server-side highlighting on dev.** Shipped and unit-tested, but the visible result
      has not been eyeballed. Azure returns windowed fragments for a long field, so a long project
      description now renders as fragments joined by an ellipsis rather than in full.

## Cost

Spend is roughly 200 CAD/month against a 100 CAD budget. AI Search Basic (~74/month) is the only line
this team controls, and dropping it means losing fuzzy search. Defender for Cloud (~48/month) is the
second-largest line and is almost certainly set by platform policy — ask the platform team, do not
turn plans off. Breakdown in
[Azure Environments](https://github.com/digitalspace/eagle-demi/wiki/Azure-Environments).

The AI summariser adds a new line, and it is the first one that is **per-token rather than per-hour**.
It is now live in dev, and the token counts are measured: 2,835 prompt / 124 completion tokens, ~11 s
end to end (`keywords=wildlife mitigation`, 5 citations, 2026-08-05). The dollar figure is *derived*
from those counts, not measured — Azure bills on its own meter and nobody has reconciled an invoice
here. At the canadaeast `gpt 4.1 mini Inp/Outp regnl` retail rates (0.70 / 2.70 CAD per 1M) that is
**~0.0023 CAD a query**, so ~2.32 CAD/mo at a thousand queries.

Quoted in CAD, like every other cost on this page. `az consumption budget list` reports
`demi-budget-dev` in CAD, so a per-query figure in USD was one more conversion between a number and
the budget it draws down.

This figure read $0.00050 USD until 2026-08-06. That was wrong twice over: `config.js` carried
4o-mini list rates ($0.15 / $0.60) while `foundry.bicep` deploys gpt-4.1-mini on the regional
`Standard` SKU, so every cost shown in the UI and quoted in the docs was 3.2x low. The formula in
`estimateCostCad` was never the problem — the constants it multiplied were. The pre-deploy ADR-006
estimate of $0.0006 was likewise low for the same reason: it priced a model that is not deployed.
The corrected line is still ~2% of AI Search Basic, so nothing decided on the old number changes.

It scales with use rather than with time, which is why the endpoint is privileged-only and why
`summarize.js` logs prompt/completion tokens on every call. Watch the logged p95 rather than assuming
the estimate, and re-check the rates against `prices.azure.com` (with `currencyCode='CAD'`) whenever
the deployment's model or SKU changes — the constants do not follow the bicep on their own.

## Decided — do not redo

Closed with a reason, kept because a dismissal is invisible until someone re-derives it.

- **4 x `js/path-injection` in `src/controllers/nosql/document.js` — false positives, dismissed
  2026-08-07 (#73).** Every one is `fs.promises.unlink(file.path)`, and multer generates that name
  itself. Do not "fix" them if they reappear.
- **`js/insecure-helmet-configuration` (`contentSecurityPolicy: false`) — won't fix, dismissed
  2026-08-07 (#73).** The API serves exactly one HTML page, swagger-ui, whose inline initializer a
  default CSP blocks. A policy that exempts the only page it covers protects nothing.
- **The rate limit is real now, so callers behind one NAT share a 300/minute bucket (#73).** Nobody
  has measured that under load.
- **Do not spend a 300-request run against a single-worker B1 to re-verify the limiter (#73).** The
  `draft-7` counter decrementing across four separate connections is the discriminating probe — a
  per-connection key could not produce a monotonic decrement.

## Open decisions

| # | Question | Default | Cost of reversing |
|---|---|---|---|
| 1 | ~~Backup mode `Continuous7Days` on dev~~ | **Closed 2026-08-07: already enabled** | `az cosmosdb show -g c4b0a8-dev-rg -n demi-cosmos-dev --query backupPolicy` returns `type: Continuous`, `tier: Continuous7Days`. This row said "Not done" and was stale — checked while sizing the blast radius of the NRPTI purge, where 7-day self-service restore was the difference between a reversible and an irreversible 48,413-row delete. The trade it describes is already taken: Geo backup redundancy is gone, PITR is live |
| 2 | ~~Semantic ranker left enabled~~ | **Closed 2026-08-05: in use** | It is now the shipped ranking on `demi-chunks` — see above. Every Deep Search is a billable semantic query against an unpublished monthly free allowance; exhausting it returns HTTP 402, which the code catches once, latches, and degrades to BM25 for the rest of the process — it stops asking rather than paying a 402 plus a retry on every later search. Watch for that warning before assuming ranking is live |

Settled, and kept here only because reversing them is expensive: **index tier** (Basic — Basic→S1
needs a new service and a full reindex) and **delete propagation**
(hard delete plus immediate index delete; the `_ts` high-water mark seeing no deletes is measured,
not assumed — and now visible in `azure/search/datasources/`, none of which declares a
`dataDeletionDetectionPolicy`).

## Out of scope

`rg-epic-search` is not our project. It shares the `c4b0a8` billing group, so it surfaces in any
subscription-wide cost query — sharing a bill is not owning a system. Do not investigate it, cost it,
or track it here. Scope is `c4b0a8-dev-rg` and the DEMI resources. If something ever genuinely
couples DEMI to it, raise that specific coupling rather than reopening the area.
