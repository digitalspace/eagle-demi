# TODO

Open work only. Facts, measurements and history live in the
[wiki](https://github.com/digitalspace/eagle-demi/wiki); if something here needs a paragraph of
background, that background belongs there and this entry links to it.

Dev only, and dev deploys itself: a merge to `main` runs `azure-deploy-dev-api` and
`azure-deploy-dev-frontend`, so what is on `main` is what is on dev within a few minutes. There is
no date or commit to keep current here — read the workflow runs. This paragraph used to name the
deployed SHAs anyway, and they were stale within a day; a pointer that has to be maintained by hand
is the drift the sentence before it warns about.

The corollary is the trap: **merging is deploying.** An entry below is live the moment it lands,
including one whose infrastructure does not exist yet — see service credentials under
Infrastructure.

---

## What is actually open

The sections below are grouped by topic, which makes a blocked item read like an actionable one.
Nothing here is a separate list to maintain — it says which gate each open entry is waiting on, so
"what can I do right now" does not require reading all of it.

| Gate | Open entries waiting on it |
|---|---|
| **Nothing — do it** | Rotate the MinIO key and OpenShift token at source (the repo side is already deleted) |
| **A dev run + `az login`** | Minting the first real service key |
| **RG-scope rights nobody holds yet** | Observability / `APPLICATIONINSIGHTS_CONNECTION_STRING`; the first `main.bicep` deploy; removing role assignment `29745ac3`; Phase 3b blob storage |
| **A human in a browser, staff login** | The `/summary` render; boundary rendering at three fidelities; server-side highlighting; the scoped access tier |
| **A decision, not work** | Test/prod deploy path and the release model; app registration `acb4198f` |
| **Deliberately not doing it** | `pageNumber` citations; result paging; the client-side highlighter; the intake-cleaner backfill; the OnPush conversion; natural-language labels; the tiled/OCR strata; the 402 monthly rollover; `content: retrievable` |

**Before hardening, read this one first:** nothing DEMI logs is retained anywhere, so every "the
reason is logged" claim in this file means the App Service log stream — visible only to someone
already watching, and gone after. That is the observability entry under Infrastructure, and it
outranks the rest of a hardening pass for the obvious reason: you cannot harden what you cannot
observe. It is also the entry with the least code in it and the most permission.

Both of the things the rate-limiter fix left for that pass are now done, and the first is worth
reading before anyone plans a load test here:
- **The limiter is verified on dev, and it cost four requests — not 301.** This entry used to name
  a 301-request probe (the 301st must be 429). That works, but a cheaper probe discriminates just as
  hard: `express-rate-limit` emits `draft-7` headers, so `GET /api/config` reports the counter
  directly. Four separate connections, one window, 2026-08-07:
  `remaining=297 → 296 → 295 → 294`, `ratelimit-policy: 300;w=60`.
  **That is the whole bug, inverted.** The pre-#73 build minted a new key per TCP connection, so it
  would have answered `299` every time no matter how many requests arrived — a monotonic decrement
  is something only a stable key can produce.
  The honest limit: this verifies the KEY, not the 429 at the boundary. Once the key is stable,
  reaching zero is arithmetic inside `express-rate-limit` rather than anything this repo wrote.
  Do not spend a 300-request run against a single-worker B1 to re-learn this.
- **The access invariants now have a suite asserting them as a set** —
  `test/helpers/access-coverage.test.js`. The helper tests could already show that `visibilityFor`
  emits the right predicate; nothing could show that a read path *uses* one. It asserts every
  repository routes through `_sql.js`'s `selectWhere`/`countWhere` (which is also how "counts use
  the same predicate as reads" holds by construction), and that every `cosmos.readItem` is followed
  by `canRead`, since a point read bypasses the query predicate entirely.
  `api-keys`, `boundaries` and `wildfires` are allowlisted with the reason each needs no gate, so a
  NEW repository fails the suite until somebody classifies it. Verified it can fail: stripping the
  `canRead` from `projects.js:77` turns it red with that exact diagnostic.
  It scans source text rather than parsing an AST, which is a deliberate ceiling — it cannot stop
  someone determined to route the call through a variable, and it does stop someone who forgot.
  Forgetting is the failure that actually happens here.
  **Still uncovered, and the reason a behavioural suite may earn its place later:** OData has no
  `false` literal, so a null or empty filter is UNRESTRICTED. A search route that forgets the
  `empty` flag fails **open**, and a structural scan cannot see that — it would see `filterFor`
  being called and be satisfied.

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

### Fixed

- [x] **Boundaries can be restricted now.** This was the one container where a restriction was
      *inexpressible*: no `read[]` on the items, no `access` argument on any repository function. A
      staff-only shapefile would have been world-readable the moment it was inserted. Reads compose
      `selectWhere`/`countWhere` and point reads gate on `canRead`, exactly like every other
      repository; `transformBoundary` emits an explicit ACL, public by default, and preserves an
      upstream `read[]` verbatim so a re-seed cannot republish a restricted shapefile.
      **Project scope deliberately does NOT apply** — boundaries are geography, not project data, so
      `visibilityFor` is called with a NULL partition field. Scoping them on a field the items do not
      carry would match nothing and blank the map for every project-scoped caller.
      `boundaries.js` is no longer in the coverage suite's allowlist.
- [x] **`projectScope` was silently void on any privileged credential.** `resolveAccess` returned
      `{tier: PRIVILEGED, projectScope: null}` *before* it ever read the scope, so a key minted as
      `roles: ['staff'], projectScope: ['207']` read the **entire corpus** — the restriction its
      issuer asked for did nothing and said nothing. Scope is resolved first now. Roles and scope are
      orthogonal: privilege lifts the ROLE predicate, the project narrowing survives. Mirrored in
      `access-odata.js`, which had the same short-circuit. `systemAccess()` is unaffected and there
      is a test saying so, because it is constructed rather than derived from a request.
      The test that pinned the old behaviour asserted *"privileged roles ignore scope entirely"* —
      it was pinning the bug.
- [x] **Unauthenticated 500s no longer echo the driver message.** A Cosmos SDK error carries the
      account endpoint, database and container names; `GET /projects`, `/documents`, `/boundaries`
      and the unauthenticated `/api/health/db` all returned it verbatim. `serverError()` logs the
      detail and returns a fixed string.
- [x] **`read[]` and `isPublished` are no longer settable from a PUT body.** Both handlers spread
      `req.body` into the upsert, so a writer could hand-craft an ACL past `resolveDocumentAcl` and
      past the 409 that stops a document being published under a private project. Documents keep the
      ACL they had; projects derive it from `isPublished` so read[] and isPublished cannot disagree.
- [x] **`documents.countVisible` fanned out across every partition** even when it held a
      `projectId`, while the matching read did not. It takes the partition key now.
- [x] **Missing index paths added**: `documents /id` and `boundaries /id` (the cross-partition
      by-id fallback, which is the live path), `chunks /isPublished` (the ACL fallback arm, so every
      non-privileged chunk read carried an unindexed term), plus `read[]`/`isPublished` on
      boundaries.
- [x] **The coverage allowlist asserts the router instead of citing it.** Its reasons cited
      `routes/api.js:106` and `:115`; the NRPTI removal shifted every line and the suite kept passing
      while the evidence silently stopped matching — exactly the rot its own `ponytail:` comment
      predicted. `requireWritePrefixes` now parses the router and checks the middleware chain, and
      asserts `GET /wildfires` still does not exist.
- [x] Dead code deleted: `_sql.contains()`, `PARTITION_FANOUT_LIMIT`, `wildfires.count()`, and the
      `pageSize` clamps to 5000 that `pageOptions` immediately re-clamped to 1000.

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

- [ ] **Restricting a document takes effect in search up to 5 minutes late.** The indexers are the
      only writers to the index — `docs/index` is used exclusively for `delete` actions, there is no
      merge/upload path — so an ACL change in Cosmos reaches `demi-chunks` and `demi-documents` only
      on the next `PT5M` high-water-mark pass. The API restricts instantly; Deep Search does not.
      Pushing the change directly is not obviously right: a document unpublish means updating every
      chunk of that document, which for a large PDF is thousands of index rows and a race against
      the indexer. Stated as a known ceiling rather than fixed.
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

---

## Infrastructure

- [x] **`documents.buildCriteria` treated `projectId: ''` as "no filter" — aligned in #73.** A falsy
      `if (projectId)` meant asking for the empty partition returned the WHOLE container. It was
      never live — no caller passes `''` and nothing sweeps a documents `''` partition — so this was
      aligning the shape before something does, which is the only cheap moment to do it. Both the
      criterion and the `partitionKey` are presence tests now (`!== undefined && !== null`), with a
      repository test asserting the emitted SQL carries `c.projectId = @projectId` and that
      `options.partitionKey === ''`.

- [x] **CodeQL is at 0 open alerts, 2026-08-07 — and the entry that closed it was wrong about why.**
      38 after #59–#65; the 7 that were decisions rather than defects were dismissed with their
      reasons; the last 31 were `js/missing-rate-limiting` and closed with #73.
      The 3 medium `actions/missing-workflow-permissions` from the first scan are fixed — `pr.yaml`
      declares `permissions: contents: read` — and `js/incomplete-multi-character-sanitization` is
      closed by the fix recorded below. The dismissed 7 are kept written down here because a
      dismissal is invisible until someone re-derives the reasoning:
      - **31 x `js/missing-rate-limiting`** across `src/routes/api.js` and `src/app.js:126`.
        **This entry used to say "there is no rate limiter mounted on the Express app at all". That
        was false**, and worth keeping visible rather than quietly rewriting:
        `git show 32fd4a6:src/app.js` requires `./middleware/rate-limiter` at line 30 and mounts it
        at line 37, both long predating the claim.
        What was really there was **two independent problems that happened to share one fix**:
        1. **CodeQL could not recognise it.** The limiter was a hand-rolled `Map` in
           `src/middleware/rate-limiter.js`, which the query does not know as a rate limiter, so the
           cluster tracked the route count and grew with #60's `/admin/api-keys` routes. Moving to
           `express-rate-limit` closed all 31.
        2. **It did not limit anything.** It keyed on the whole `X-Forwarded-For`, and App Service
           **appends** `<client-ip>:<port>` to that header. The port changes with the TCP
           connection, so nearly every request minted a new key and the 300/minute ceiling was
           unreachable. Measured against dev 2026-08-07: **320 requests inside one window, all
           200.** Reproduced in `test/middleware/rate-limiter.test.js`.
        Only the first was visible to the scanner. A cosmetic swap would have closed all 31 alerts
        and left the limiter just as inert — the defect was found by measuring, not by triaging.
        The key is now `callerIp()`: LAST comma-separated entry (everything before it is
        caller-supplied), port stripped, IPv6 normalised to a /64 by the library's `ipKeyGenerator`.
        `src/middleware/http-logger.js` shares the same resolver, so the audit log and the limit
        cannot disagree about who a caller is — it used to log the raw header, i.e. an
        attacker-chosen string.
        **Behaviour change worth knowing:** the limit is real now, so callers behind one NAT share
        a 300/minute bucket. Nobody has measured it under load — see the hardening note below.
      - **`js/insecure-helmet-configuration`** at `src/app.js:41` — helmet is mounted with
        `contentSecurityPolicy: false`. **Decided 2026-08-06: dismiss, do not implement.** The
        question was "can the frontend live under a CSP", and the answer is that the API does not
        serve the frontend at all — the `express.static` mounts and SPA routes that suggested it did
        are deleted (see below). What is left is exactly one HTML page, swagger-ui at `/api-docs`,
        whose inline initializer script and inline styles a default CSP blocks. A policy that
        exempts the only page it covers protects nothing. **Dismissed 2026-08-07** as "won't fix"
        with that reason.
      - **`js/incomplete-multi-character-sanitization`** in
        `frontend/src/app/services/registry-state.service.ts` — **fixed 2026-08-06, and the alert
        named the smaller half of it.** `sanitizeHighlight` stripped tags with a single-pass
        `replace(/<[^>]*>/g, '')` (what CodeQL flagged) and then ran the result through a
        hand-written table of ~30 HTML entities, which turned `&lt;img …&gt;` back into a live
        `<img …>` as the LAST step before returning markup bound with `[innerHTML]`. Measured
        against the old code: the strip itself held (`[^>]*` swallows a nested `<`, so
        `<scr<script>ipt>` did not re-form), and the decode was the actual hole. Angular's
        `DomSanitizer` is what kept it from being an XSS — there is no `bypassSecurityTrustHtml`
        anywhere in the app — so this was one bypass call away from live, on a path that carries
        text extracted from uploaded PDFs (`map-explorer.component.html`, document snippets).
        Both halves are now one `DOMParser().parseFromString(part, 'text/html').body.textContent`
        followed by the file's existing `escapeHtml`, and the entity table is deleted.
      - **4 x `js/path-injection`** in `src/controllers/nosql/document.js` (171, 177, 189, 220) are
        **false positives** — every one is `fs.promises.unlink(file.path)`, and `file.path` comes
        from `multer({ dest: config.uploadDir })`, which generates its own random filename and never
        derives it from `originalname`. **Dismissed 2026-08-07** as false positives with that note;
        do not "fix" them if they reappear.
      - **`js/clear-text-logging`** at `src/scripts/copy-blobs-to-azure.js:146` — also a **false
        positive**, and it was missing from this entry rather than newly appeared. The line is
        `console.log('Destination:', JSON.stringify(azure.describe()))`, and `describe()`
        (`src/storage/azureBlob.js:133`) returns `{backend, account, container, keyPrefix: null}` —
        resource names, no credential. CodeQL flags it because `config.*` reaches a log sink, not
        because a secret does. **Dismissed 2026-08-07.**
      - **`js/insufficient-password-hash`** at `src/helpers/api-key.js:31` — **new with #60, and a
        false positive.** The digest is SHA-256 over 32 bytes of `crypto.randomBytes`, not over a
        human-chosen password. A KDF exists to make guessing a low-entropy secret expensive; there
        is nothing to guess here, so bcrypt/argon2 would buy nothing and add latency to every
        authenticated request. What matters is that the compare is constant-time, which
        `api-key.js:verify` does with `timingSafeEqual`. The reasoning is already in that file's
        header. **Dismissed 2026-08-07** with it.
- [x] **Angular 19 → 22 and TypeScript 5.7 → 6.0, done 2026-08-06.** 19.2.25 was end-of-life and
      carried 7 runtime advisories with `first_patched_version: null` — XSS via i18n event-handler
      attributes, hydration DOM clobbering and response-cache poisoning, `HttpTransferCache`
      cache-key ambiguity, a DoS via OOM in date formatting — plus 26 development-scope alerts that
      could not move while `@angular-devkit/*` was pinned to 19. Landed as three hops (19→20→21→22)
      on one branch, one commit each, because `ng update` only crosses one major at a time.
      The dependabot `ignore:` block is gone; the `angular` group that replaces it still lists every
      scope, which is the lesson PR #42 taught.
      What it actually cost, against the estimate of "two majors of real work":
      - **`ng update`'s temp-CLI bootstrap is broken under Yarn 4** and fails with no error at all —
        it installs the temporary CLI into a PnP dir and then cannot require it. Work around it by
        bumping the packages with `yarn up` first and running migrations with
        `NG_DISABLE_VERSION_CHECK=1 yarn ng update <pkg> --migrate-only --from=<a> --to=<b>`.
      - **TypeScript 6 cost nothing.** It was the budgeted risk; `registry-state.service.ts` needed
        no change. The real work was all in v22's behavioural defaults.
      - **The v22 safe-navigation migration was reverted deliberately.** It wrapped 8 template
        expressions in `$safeNavigationMigration(...)` to keep `a?.b` yielding `null` rather than
        `undefined`. Every call site behind those bindings already declares
        `string | undefined | null` and branches on both, so the shim preserved nothing and read as
        noise. The `extendedDiagnostics` suppressions that came with it went too — the build is
        clean without them.
      - **`provideHttpClient(withXhr())` was kept.** v22 defaults `HttpClient` to the fetch backend,
        and this app monkey-patches `window.fetch` in `RegistryStateService` to attach bearer
        tokens. `ConfigService` is the only `HttpClient` caller and runs before Keycloak
        initialises; XHR keeps it out of that interceptor, which is what it did on 19.
      - **Karma stayed.** v22 offers a vitest migration; the two spec files did not need it. The
        builder is now `@angular/build:karma`, and `karma.conf.js` no longer names the deleted
        `@angular-devkit/build-angular` framework/plugin.
      - Bundle went 436.65 kB → 457.07 kB raw (114.13 → 119.33 kB transfer) across three majors.
        37/37 tests passed on the branch; the app boots and renders on `ng-version="22.1.0"`.
        Re-verified after #63 and #64 merged on top of it — **44/44 frontend, 633/633 API** — which
        matters because those two are the only specs exercising `DOMParser` and the signal-derived
        chip list under v22's defaults.
- [ ] **Every component now declares `ChangeDetectionStrategy.Eager`, and the lint rule that says so
      is switched off.** v22 makes OnPush the default and its migration wrote the explicit opt-out on
      all five components to preserve v19 behaviour; `@angular-eslint/prefer-on-push-component-
      change-detection` then failed the build, so it is disabled in `frontend/eslint.config.js` with
      the reason. Only map-explorer and summarizer hold local signals — the rest read service signals
      and mutate plain fields from async callbacks, which OnPush would stop rendering, and the two
      spec files would not catch it. Converting them is a change-detection rewrite with its own
      verification; re-enable the rule when it happens.
- [x] **The API served a dead copy of the frontend, and two of its routes hung. Deleted
      2026-08-06.** `src/app.js` mounted `express.static('../public')` on `/`, `/admin` and `/demo`
      plus a `res.sendFile` SPA fallback for `/map`, `/search` and `/intake`. `public/` is
      **untracked**, so no clone has it and nothing was ever there in Azure: the static mounts fell
      through to the 404 and were dead weight. The sendFile routes did worse — measured on dev,
      `GET /map` returned **no response at all for 90 s**, and App Service holds such a request for
      its full 240 s timeout. Three unauthenticated routes that each pin a request that long matter
      on a single-worker B1.
      **The rule this leaves behind: never `res.sendFile`, or any streaming response, under the
      Functions adapter.** `api/index.js` fabricates `res` as a bare EventEmitter and resolves its
      promise inside `res.end`; `send` streams instead and, on the missing-file path, never calls
      it. Under a real `http.Server` the same request fails fast with a 500 carrying the ENOENT —
      which is why this was invisible locally and had to be found by asking the deployed API.
      Two things fell out of it: `/search` was never an SPA route at all, because
      `app.use('/', apiRoutes)` already mounted the search endpoint at the root and shadowed it; and
      `scripts/package-api.py` did not exclude `public/`, so a deploy from a working tree holding a
      stale build would have shipped it into `wwwroot`, where zipdeploy's merge makes it permanent.
      Both now pinned by tests (`test/app.boot.test.js`, `test/scripts/package-api.test.js`).
- [ ] **Test and prod have no deploy path at all — the workflows were deleted 2026-08-05.** Nothing
      is deployed in either subscription and neither has a resource group, so the files were dead
      weight naming prod resources in a public repo. Rebuilding them needs, per environment: a
      managed identity, a federated credential on subject
      `repo:digitalspace/eagle-demi:environment:{test,prod}` matching a GitHub environment of that
      name, role assignments in that subscription, and for prod a decision on required reviewers.
      Copy the dev pair as the shape. Also settle the release model first — prod is supposed to
      deploy a tag verified on test, which neither deleted workflow actually enforced.
- [ ] **App registration `acb4198f-64db-4485-9638-a894e2d2c99b` — KEPT deliberately, not for CI.**
      Left from the app-registration route before `demi-cicd-dev` superseded it. Not deleted: app
      registrations are hard to provision in this tenant, and human federated sign-in is precisely
      what the landing zone says they are for. It holds no role assignment, so it grants nothing
      today. It DOES still carry the GitHub Actions federated credential `github-eagle-demi-main`
      (subject `repo:digitalspace/eagle-demi:ref:refs/heads/main`) — dormant while the app has no
      permissions, live the moment it gets any, from a PUBLIC repo. Settle that before wiring this
      app to sign-in.
- [x] **CI was running Yarn 1 against a Yarn 4 repo — fixed 2026-08-05.** Neither `package.json`
      declared `packageManager`, so `corepack enable` on `ubuntu-latest` fell back to the
      preinstalled **1.22.22** (visible in any build log as `yarn run v1.22.22`). Yarn 1 does not
      recognise `--immutable` and ignores it, so every `yarn install --immutable` in `pr.yaml` and
      the deploy workflows guaranteed **nothing** — CI resolved dependencies fresh from the registry
      on every run and the lockfiles were decorative. That is a reproducibility hole and a supply
      chain one: a fresh resolve installs whatever is in range, which is the exact thing a lockfile
      prevents. It stopped being theoretical when PR #48's build died on `Couldn't find any versions
      for "@jsonjoy.com/fs-node-utils" that matches "4.68.0"` while the lockfile pinned **4.64.0**.
      Both manifests now pin `yarn@4.12.0`, and both lockfiles were regenerated under it —
      normalisation only, **zero package version changes**: 423 root and 1106 frontend resolutions
      before and after, differing only in Yarn's internal `#~builtin` → `#optional!builtin` patch
      notation. `cacheKey` moved `10` → `10c0`, which is what the old locks having been written by
      an older Yarn looked like.
- [x] **CI never ran the frontend tests — fixed 2026-08-07.** `pr.yaml`'s `test-frontend` job ran
      `lint` and `build` and no `test`, while `test-api` beside it ran both. The gap was invisible
      because the job is *named* "Test & Build Frontend" and went green on every PR.
      What it let through: #70 bumped **jasmine-core across a major** (5.6 → 6.3) and merged with a
      passing check having executed none of the 44 specs. They were run by hand afterwards and
      passed — which is luck, and luck is not a gate. Same PR batch also moved zone.js 0.15 → 0.16
      under Angular 22, where a spec failure is exactly the expected symptom.
      Now one step: `yarn --cwd frontend test --no-watch`. `--no-watch` because `ng test` otherwise
      waits for file changes and never exits; no `--browsers` flag because `karma.conf.js` already
      defaults to the sandbox-less `ChromeNoSandbox` launcher a runner needs.
      The general lesson is the one this file keeps relearning: **a check that cannot fail proves
      nothing**, and a job name is not evidence of what the job runs.
- [x] **The five API majors are done — taken individually, each against a probe, 2026-08-05.**
      They arrived as one green group PR (#35, closed) whose greenness meant nothing. Split up and
      landed one at a time, each with a BEFORE reading so the check could actually fail:
      - **express 4.22.2 → 5.2.1** (#48). `src/` has no `req.param()`, no `app.del` and no wildcard
        or optional route patterns, so path-to-regexp v8 had nothing to reject — but that came from
        reading the source, not from CI, because no test mounted the app. `test/app.boot.test.js`
        was written first and is the evidence: it mounts `src/app.js`, serves `/api/config` and
        checks the 404 fallback, and passed under 5.2.1 in CI before the merge.
      - **minio 7.1.3 → 8.0.7** (#49). `src/storage/minio.js` is the live path to
        `nrs.objectstore.gov.bc.ca` behind every download, and nothing tests it. Probed end to end
        against a real document, before and after: `/api/documents/:id/download` → 200 with an
        AWS4-signed URL, and that URL → 206 with actual bytes. Identical both sides.
      - **jwks-rsa 3.2.2 → 4.1.0** (#50). Breaking changes are jose v6 and Node ≥ 20.19; this runs
        Node 22, and `jwksRequestsPerMinute` survived. Probe was a token with an unknown `kid`,
        forcing a real JWKS lookup: 401 before and after. A broken client answers 500, not 401.
      - **helmet 7.2.0 → 8.3.0** (#54). Only `contentSecurityPolicy: false` is set. Compared the
        full security-header set before and after — byte-identical, nothing regressed.
      - **serverless-http 3 → 4** (#51) — not upgraded. Nothing in the repo required it, so the
        dependency was deleted instead.
      `scripts/validate-deploy.sh` 25/25 after each. **Root `yarn.lock` now has zero Dependabot
      alerts.** The probes were one-off, not committed — the minio and auth ones are worth keeping
      if these are ever upgraded again.
- [x] **The one Dependabot alert is build-toolchain only — dismissed 2026-08-07.** Medium,
      `@hono/node-server`, path traversal in `serve-static`. Traced rather than assumed:
      `@hono/node-server` ← `@modelcontextprotocol/sdk` ← `@angular/cli@22.1.3`, which is the
      Angular CLI's own MCP server for editor assistants. It is absent from the browser bundle and
      from the API entirely — `yarn why` in `frontend/` is the whole chain, and nothing in
      `frontend/src` imports either package. Reaching the vulnerability means running the CLI's MCP
      server and exposing its static handler, which no workflow and no runtime here does.
      Dismissed as "not affected" with that chain on the alert. Written down here for the same
      reason the CodeQL dismissals are: a dismissal is invisible to anyone reading the repo, and the
      next reader would otherwise re-derive it or "fix" it by pinning a transitive dev dependency.
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
- [x] **Service credentials work — the `apikeys` container was created 2026-08-07.** #60 shipped
      per-consumer registry keys (`X-Api-Key: demi_<env>_<keyId>_<secret>`, minted through
      `POST /admin/api-keys`, with their own roles, expiry and revocation), the `demi-service-read`
      read-only tier, and `requireWrite` on every mutating route. It deployed the moment it merged,
      and for a few hours it could not work: `src/repositories/api-keys.js` reads a Cosmos container
      declared **only** in `azure/modules/cosmos-nosql.bicep`, a template that has never run.
      Fixed WITHOUT deploying that template, which is the point worth keeping: container creation is
      control-plane, so it is one `az cosmosdb sql container create -g c4b0a8-dev-rg
      -a demi-cosmos-dev -d demi -n apikeys --partition-key-path /id`, with the same indexing policy
      the Bicep declares (`/createdAt` indexed; `/*`, `/hash` and `/_etag` excluded — nothing
      queries by the digest, and an index is one more copy of it). The Bicep declaration exists so
      the template keeps describing dev, not as the delivery mechanism.
      Verified end to end: `GET /api/admin/api-keys` with the break-glass key answers **200 `[]`**,
      which is the discriminator — it proves the container exists AND that the app reaches it over
      the private endpoint. The Azure MCP cannot do this check: its Cosmos tools are data-plane and
      the account firewall answers 403 to anything off the VNet, so the control plane (ARM) is the
      only way in from a laptop.
      **The registry is empty, so `ADMIN_API_KEY` is still the only credential.** Minting the first
      real key is the next step, and that is what break-glass is for.
- [ ] **`main.bicep` has never been deployed and still should not be.** It now describes dev
      accurately — `az deployment group what-if` reports zero creates and zero deletes against the
      live group — but it has never actually run. The dev infra job was reduced to `az bicep build`
      on 2026-08-04 and moved out of the deploy path entirely on 2026-08-05, into `pr.yaml` as
      `validate-bicep`. Deploying the template for the first time is its own decision. CI cannot
      make that decision by accident: `demi-cicd-dev` holds Website Contributor on two App Services
      and nothing at resource-group scope, so it cannot run an ARM deployment even if a job were
      added back.

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
- [x] **Ranking degradation is now readable — `GET /admin/index-progress`, 2026-08-06.** Basic tier
      allows 2 concurrent semantic requests per search unit against a frontend that searches on
      debounced keystrokes, so `semanticErrorHandling: 'partial'` returning BM25 order is an expected
      path, not an edge, and it answers 200 in the same response shape. `search.semantic` on that
      endpoint reports `requested`, `partial`, derived `ranked`, `lastPartialReason`, `lastPartialAt`,
      `exhausted` and `exhaustedAt`. A 402 counts as `partial`, because the search that provoked it
      served the stripped retry's BM25 order. **If `partial` tracks `requested` one-for-one under
      ordinary single-user load, that is the finding this was built for** — it means the scorecard is
      measuring an order no user gets.
      Per-process, and back to zero on every recycle: it answers "since this process started, was
      ranking running?" and nothing longer. That is the honest resolution on a single-worker B1, and
      it is not a time series — see the entry below for why a time series is not available.
- [ ] **Nothing DEMI logs is retained anywhere. `useAzureMonitor` has never started.** Measured
      2026-08-06: `api/index.js` starts the Azure Monitor OpenTelemetry distro only
      `if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING)`, and `demi-api-dev` has no such app
      setting. Nor could it have a working one — `az group resource list` on `c4b0a8-dev-rg` shows
      neither `demi-logs-dev` nor `demi-insights-dev`. The portal-created orphan
      `workspace-c4b0a8devrgYb8e` that `azure/modules/observability.bicep` was written to replace is
      **deleted** (2026-08-07) — it had ingested zero rows and no diagnostic setting anywhere pointed
      at it, so it was never going to become the pipeline. The two `setByPolicy-LogAnalytics`
      settings on Cosmos and AI Search go to the landing zone's own
      `bcgov-managed-lz-live-la` in a different subscription; platform telemetry, not ours, and not
      queryable as an app log. That module has never been deployed, because `main.bicep` has never
      been deployed.
      So every "the reason is logged" claim in this file means "written to the App Service log
      stream", which is visible only to somebody already watching, and gone after. That is the exact
      failure `observability.bicep`'s own header describes, and it is why the ranking entry above had
      to become counters on an endpoint rather than an alert rule on a log line.
      Fixing it is not code: deploy the observability module, then set
      `APPLICATIONINSIGHTS_CONNECTION_STRING` on both app services. Blocked behind the standing
      decision on first deploying `main.bicep`, and on RG-scope rights `demi-cicd-dev` does not hold.
- [ ] **The 402 latch does not un-latch when the month rolls over.** A single 402 turns semantic off
      for the life of the process, which is what stops every later search paying a wasted 402 plus a
      retry. But the allowance resets monthly and the latch does not, so a process that spans the
      rollover keeps serving BM25 until it restarts. Fine today — App Service recycles well inside a
      month — and the trade is deliberate: the alternative is re-probing on some timer nobody would
      tune. If the app ever gets long-lived, restart it after a 402 rather than waiting.

## Search UI

- [x] **The sector chips were not missing counts, they were matching the wrong projects. Fixed
      2026-08-06.** This entry used to describe the work as a `facets` parameter plus UI. Measured
      against dev first: `/api/search?dataset=Project&pageSize=500` returns **382 projects across 33
      distinct sector values**, and the four hardcoded chips matched by substring, so
      **`Transportation` matched 0 of 382** (nothing in the corpus contains that word — the values
      are `Transmission Pipelines`, `Public Highways`, `Railways`, `Airports`, `Marine Port
      Facilities`), `Energy` missed `Power Plants` (87, the largest sector) and caught only `Energy
      Storage Facilities` (22), and the `startsWith('mine')` special case missed `Coal Mines` (32)
      while catching `Mineral Mines`. Chips are now built from the data with a count each, matched
      exactly on the trimmed value; the live render is 31 chips led by `All Sectors (382)`.
      Values are TRIMMED before grouping because the data carries whitespace twins —
      `Groundwater Extraction` ×9 beside `Groundwater Extraction ` ×9, same for `Shoreline
      Modification` and `Water Diversion` — which is why 33 raw values render as 30 chips.
      **No `facets` parameter, deliberately.** 382 < the `pageSize=500` the loader already asks for,
      so the browser holds the whole corpus and the counts come from the SAME predicate the chip
      then applies (`matchesProjectFilters`, called once with `skipSector`) — which is the only way
      a count is guaranteed to equal what clicking it returns. A server facet could not promise that
      next to the region filter, which is geometric (`isPointInPolygon`), not a field equality Azure
      can count. Ceiling recorded in the code: past `pageSize` these become counts of a page, and
      the answer then is paging or a server facet, not a bigger number in the URL.
      The fields are all still `facetable: true` in `azure/search/indexes/`, so a server facet
      remains available the day the corpus outgrows one page.
      One case the counts have to carry: because the list is counted under the OTHER active filters,
      narrowing the region can empty the sector the user already picked. The selected value is
      pinned into the list at `count: 0` rather than disappearing — otherwise the chip vanishes
      while `sectorFilter()` still holds it, leaving an empty map, no chip rendered active, and no
      control to clear the filter that emptied it.
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

- [x] **AI Services Hub registration — retracted, it never gated anything.** This entry claimed the
      Hub governs provisioning a `Microsoft.CognitiveServices` account and that the summariser was
      blocked on filing a request. Checked instead of inferred: <https://bcgov.github.io/ai-hub-tracking/>
      documents OIDC trust setup and GitHub workflows, with no project inventory and no approval
      queue, and three Azure OpenAI accounts already exist across the EPIC subscriptions —
      `ai-epic-poc-east` (test), `c4b0a8-dev-cond-ext-oai` (dev), `ai-condition-extractor-prod`
      (prod) — each created directly by a named individual. `demi-search-dev` was created the same
      way. The claim was propagated into ADR-006 and `foundry.bicep`; both are corrected.
- [ ] **See the summariser in a browser.** `demi-foundry-dev` is deployed and `GET /api/search/summary`
      returns grounded summaries with citations, usage and cost (verified 2026-08-05 with an
      `X-Api-Key`). The `/summary` page is in the deployed frontend bundle, but every route into it
      needs a staff Keycloak login, so the rendering — answer card, sources list, `est. $…` line —
      has not been seen. Log in on `demi-frontend-dev.azurewebsites.net/summary` and look.
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
- [x] **7 CodeQL alerts dismissed with their reasons, 2026-08-07.** Every open alert except the
      rate-limiting cluster: `js/insecure-helmet-configuration` as "won't fix", the 4
      `js/path-injection`, `js/clear-text-logging` and `js/insufficient-password-hash` as false
      positives. The reasons are on the alerts AND in the Infrastructure entry above, because a
      dismissal comment is invisible to anyone reading the repo. Open count 38 → 31 that day, then
      **31 → 0** when #73 closed the rate-limiting cluster the next.
      The number is worth nothing on its own from here — 0 is the floor, so what matters for a
      hardening gate is the delta: no new alert survives a PR.
- [x] **`delete_branch_on_merge` is on, and the stale worktrees are gone — 2026-08-07.** The setting
      is what made 21 branches accumulate; flipping it after they were deleted means the pile starts
      from zero rather than rebuilding. `origin` now holds `main` and nothing else.
      When branches do need counting again: `gh pr list --state merged` intersected against
      `git ls-remote --heads`, never `git branch --merged` — these are squash merges, so a merged
      branch's tip is not an ancestor of `main` and `--merged` reports 1. That is also why the seven
      worktrees under `.claude/worktrees/` could not be cleared by `git worktree prune`, which only
      removes entries whose directory is already gone: each needed `git worktree remove`, and each
      was checked for unmerged content first rather than trusted to the branch name.
      Two were not in the merged-PR list and had to be settled by content:
      `fix/nrpti-purge-followups` diffs **empty** against `main` for its own files, and
      `worktree-todo-review-corrections` held only an uncommitted `TODO.md` draft superseded by #71.
      That draft's one substantive idea — reuse `seed-nosql.js`'s `trackProjectId >= 8000000` test
      as the purge's definition of "synthetic" — was already **rejected on better grounds** in the
      shipped code: `purge-nrpti-seeded.js:50-60` requires `sourceSystem: 'nrpti'` **and**
      `metadata.seededFromNrpti`, because provenance alone is a field a future importer could
      legitimately set, and the pair is what makes a hand-created NRPTI project get reported instead
      of deleted.
      The 22 local branches are left alone deliberately — 18 are merged and all of them are
      invisible clutter that costs nothing, which is not the same problem as a worktree holding a
      stale checkout.

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
