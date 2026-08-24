# TODO

> Condensed 2026-08-24 from a 3,422-line original, and **that original is gone** — deleted
> deliberately 2026-08-24, never committed anywhere (it was uncommitted working-tree growth; the
> last committed pre-condense copy is 581 lines at `8777e35`, itself a partial). Closed-item
> narrative, measurements and reviewer history that are not restated below no longer exist in any
> copy. A handful of lines still say "in the archive" with an F-number: those pointers are dead,
> and what they promised has to be re-derived. Nothing else points at a file that is not here.

Open work only. Facts, measurements and history live in the
[wiki](https://github.com/digitalspace/eagle-demi/wiki). **Merging is deploying** — a merge to
`main` is live on staging within minutes. Append newly discovered work here before doing it; strike
a wrong line with a one-line reason rather than deleting it. The reviewer takes a **positional
sha** (`review.sh --repo eagle-demi <sha>`) — always pin it when more than one review is in flight.

## Corrections that supersede anything found elsewhere

1. **`demi-cosmos-test` was seeded from eagle-DEV, not prod** (F18, measured 2026-08-24 by
   per-year `datePosted` counts). eagle-dev is itself frozen — newest document 2026-06-15, 12
   documents from all of 2026 against prod's 899. Every earlier "test carries the prod corpus"
   claim is wrong. Prod eagle-search is the intended oracle but not a valid one for raw totals
   until the corpora share a source; the differ is now corpus-independent (selectivity booleans)
   for exactly this reason.
2. **`demi-cosmos-test` backup is Periodic: 240-min interval, 8-hour retention, Geo — two restore
   points.** NOT `Continuous7Days` (that was dev, torn down 2026-08-11). `chunks` (1,128,733 rows,
   ~3.95 GB) is the only extracted copy of that text; the `demi-search-test` `chunks` index holds a
   readable second copy but that restore path has never been tested; ~1,496 source PDFs 404 in the
   object store and are unrecoverable at any price. **Treat any destructive op on `chunks` as
   one-way.**
3. **Direction (2026-08-23): DEMI is EPIC's central data store.** Track project ids are master;
   eagle-api pushes to DEMI on write, authenticated; nothing writes back into Eagle Mongo; an Eagle
   project with no Track counterpart is retained and flagged; a Track project with no Eagle
   counterpart is NOT public (fail closed). eagle-public is the first consumer — **test search is
   already served by demi-api**, so a test regression is user-facing.

## Gate table

| Gate | Items |
|---|---|
| Nothing — do it | §1 `ADMIN_API_KEY` rotation, `RPROXY_EGUIDE_PASSWORD` rotation, scoped key; §3 items |
| Daniel decides | §2 — re-seed source, B1 shape, budget, pcp, proponentId, smaller calls |
| Needs a human in a browser | §5 |
| Someone else / long-lead | prod role assignments (§4.1); eao-nginx + eagle-public prod tags (§4.4/4.5); `demi.eao.gov.bc.ca` DNS (filed, nothing waits on it); MinIO/OpenShift rotation at source; Track feed credential |
| After the F18 re-seed | B4 analyzer refill; `isFeatured`/`documentSource` data; a fully green differ |

---

## 1. Live exposure and credentials — do first

- [x] ~~ACL data fix — 34 projects + 18 documents anonymously visible.~~ **Was already done when
      that line was written**; verified 2026-08-24. Census `trackOnly 34, trackOnlyPublic 0`, dry
      run `matched 0`, all 34 rows `_ts` 2026-08-23 21:51-21:57Z and all 18 documents 21:57:47Z
      exactly — one cascade transaction, so the `updateProject` path ran for the 4 as prescribed.
      Anon `Project` **348** = 382 track-sourced - 34. **Do not verify by name**: "Patullo" and
      "Greenhills" still return 1 each — ids 223 and 63, Eagle-sourced projects with similar names.
      Recipe kept below: a re-seed (2.1) may need it run again.
      - `node src/scripts/close-unpublished-track-projects.js` in the app container over the SSH
        tunnel, dry run then `--live`; it exits **1 by design** (the 4 skips are deliberate). Close
        those 4 through `updateProject` in-process so the #139 cascade runs — never reimplement it.
- [ ] **Rotate `RPROXY_EGUIDE_PASSWORD` eventually — low priority, and do NOT delete the route.**
      Daniel 2026-08-24: people still use `/eguide`, and the gate holds nothing confidential.
      Repo secret on `bcgov/eao-nginx`, `deploy-to-prod.yaml:138-139` via `--set`; hard swap.
- [ ] **Rotate the MinIO key and OpenShift token at source** — repo secrets deleted 2026-08-07,
      credentials still live at `nrs.objectstore.gov.bc.ca` and the token's issuer. Oldest open
      item. Needs whoever owns those systems.
- [ ] **Rotate `ADMIN_API_KEY` deliberately** (its value passed through the 2026-08-13 incident):
      new value into `demi-app-secrets` (6cdc9e-test), `gpu-extractor.env` on the GPU box, and the
      App Service; restart `gpu-extractor` and `gpu-ingest`.
- [x] ~~**Mint the first scoped service key** — until one exists no live ACL probe can fail.~~
      **Done 2026-08-24, and this line prescribed the wrong key twice.** `roles:['staff']` is
      privileged (`staff` IS in `SECURE_ROLES`, `access-sql.js:30`), so it proves the SCOPE
      narrowing and never the `read[]` predicate — the gap the item existed to close; and `staff`
      is in `WRITE_ROLES`, so the mint route refuses it without `allowWrite: true`. It takes TWO
      keys: `roles:['compliance']` (`GRANTABLE_ROLES`, `src/controllers/nosql/api-key.js:24` — not
      `helpers/api-key.js`; `public` is grantable and unprivileged too, but useless as a
      credential) for the read predicate, and `roles:['demi-service-read'], projectScope:['<id>']` — privileged,
      read-only, scoped — for the narrowing.
      - `src/scripts/probe-acl.js` runs the whole thing: mints both keys, plants a synthetic
        hidden/control pair (a `read[]` the corpus cannot supply, since every real row is public),
        asserts 26 cells over the live Cosmos list, the point read and the index, then deletes and
        revokes and verifies both. `ADMIN_API_KEY=… node src/scripts/probe-acl.js`, ~7 min (the
        search leg waits for the `PT5M` indexer). Exit 0 pass, 1 a missed prediction, 2 aborted,
        3 a leg was inconclusive — an inconclusive leg proved nothing about six cells and must not
        read as a pass to anything checking only the status.
      - **26/26 on 2026-08-24.** Anonymous and `compliance` see 0 of the hidden row and 1 of the
        control on list, search and point read (404/200); the scoped key sees its own project only,
        including private rows inside it, and 0 outside on every route; a revoked key is refused.
      - Proven falsifiable: flipping one expected value red-flags it and exits non-zero. Check
        revocation on an AUTH-REQUIRED route — `/documents` is `passiveAuth` and answers 200 to a
        rejected credential by design, so `401` there is a prediction the route can never satisfy.
      - Leaves one revoked registry record per key per run; revoke is not delete, by design.

## 2. Decisions — Daniel

- [ ] **2.1 The F18 re-seed — biggest, and the precondition for a fully green differ.**
      `EAGLE_API_BASE=https://projects.eao.gov.bc.ca/api/public node src/scripts/seed-nosql.js
      --live` upserts ~61,606 documents (prod is a complete anonymous source and carries
      `isFeatured` (337) and `documentSource`, both missing from demi). Settle first:
      - Prod (61,606 docs) or eagle-test (55,845, newest 2026-07-21) as the mirror source?
      - Effect on the 34 projects §1 closes — `resolveProjectAcl` now fails closed so the outcome
        *should* survive a re-seed, but that is reasoning, not a measurement. Verify after.
      - Chunks do NOT come with it: new documents arrive `contentExtracted: false` until the
        extractor drains them. Deep search stays ~7 months behind until that runs.
      - Container has the 8-hour undo window and an untested restore path (correction 2).
- [ ] **2.2 B1 — corpus-wide chunk metadata filters.** Two-phase resolver shipped in #142 works
      for project-scoped chunk filters; corpus-wide values exceed `DOCUMENT_SCOPE_CAP` at any cap
      one request can fill (narrowest real `type` = 2,911 documents), so the key lands in
      `meta.dropped` — honest, not parity. Options: page the resolver (~12 service calls per
      filtered chunk page on a Basic 1-SU, per debounced keystroke); denormalise onto 1,128,733
      chunks (rejected once, one-way container); **or drop the three inert controls (Milestone,
      Type, date range) from `eagle-public/src/app/search/content-search.component.ts` —
      recommended.** The API is already honest; the UI is what still lies.
- [ ] **2.3 Raise `budgetAmount`.** 400 CAD against a measured ~451 CAD/month run rate (Aug 16-22
      mean 15.03/day, trending up) — the anomaly guard now fires on normal spend. Not a silent
      bump: the RG also bills eagle-search, eagle-notify and PostgreSQL (~12/month).
- [ ] **2.4 Drop the `pcp` facet** from `eagle-public/src/app/projects/project-list.constants.ts`.
      No PCP field exists in Track or DEMI, and on prod only `closed` (66) ever worked. Shipping a
      control that returns everything is the one unacceptable option.
- [ ] **2.5 `proponent` facet needs an org id DEMI does not hold.** The Eagle push (§3.6) is
      scheduled to carry `proponentId` + label; decide whether to wait for it or backfill ~393
      rows now. Do NOT ship the name-valued shortcut (measured: 497 of 778 dropdown options match
      zero projects).
- [ ] **2.6 Smaller calls, parked until someone needs them:** may `GET /projects` narrow its
      2.32 MB payload (no in-repo consumer; the fold does NOT settle this — eagle-public uses
      `/api/search`)? Drop the dead `logs`/`leases` containers (hand-run `az cosmosdb sql
      container delete`; Bicep removal alone only creates drift)? Required reviewers on the `prod`
      environment? App registration `acb4198f` still carries federated credential
      `github-eagle-demi-main` from a PUBLIC repo — dormant while it holds no role, live the
      moment it gets one; settle before the prod build.
- [ ] **2.7 Sign off the anonymous surface before prod.** Naming the host publicly advertises nine
      anonymous GETs, not just search — `GET /projects` and `GET /documents` allow `pageSize` up
      to 1000 (bulk registry enumeration). And stop serving `/api-docs` in prod (unauthenticated,
      documents 6 of 28 routes, advertises an unenforced auth scheme). Nothing must close; it must
      be chosen.

## 3. Test hardening — code and data

- [ ] **3.1 B4 — the filename analyzer.** `keywords=mine` returns **0** on demi, **1,686** on prod:
      `azure/search/indexes/documents.json:53` puts `en.microsoft` on `documentFileName`;
      eagle-search uses a custom PatternTokenizer. Index recreate + refill — pair with the re-seed
      (2.1) rather than refilling twice. Chunk sort (every `chunks` field `sortable: false`) rides
      the same recreate if ever wanted.
- [ ] **3.2 `isFeatured` / `documentSource` / `proponentId` columns.** Index fields plus, for
      `isFeatured`, the one line `src/seed/transform.js` omits while carrying its seven siblings;
      drop the "no such field" note at `src/search/eagle-query.js:17`. Data arrives only via 2.1 —
      the 337 prod featured ids do not exist in today's corpus, so a backfill before the re-seed
      patches nothing and reports success.
- [ ] **3.3 The denormalised `projectIsPublished` ceiling (§1b).** #139 removed the urgency (the
      cascade now intersects `ownRead` and runs on both transitions), but the ceiling is still the
      lossless design and covers cascade partial-failure. Full design + the three ordering traps
      (datasource SELECT first, always; opt-in third arg to `filterFor` — naming a missing OData
      field is a 400 not an empty result; predicate and cascade-removal in the SAME release) are in
      the deleted archive under F1/§1b — re-derive. Backfill before predicate, or ship
      `(NOT IS_DEFINED(c.projectIsPublished) OR c.projectIsPublished = true)` and tighten.
- [x] ~~3.4 Reset the semantic 402 latch at month rollover.~~ #145, merged 2026-08-24
      (`e8ff8dc`). Latch stores the UTC month and clears itself on the first search of the next one
      — no timer, no restart hook. `alwaysOn: true` confirmed on `demi-api-test`, which is what had
      made the old process-lifetime latch outlive the allowance it waited on.
- [x] ~~3.5 F11a — two writers disagree on the project state field.~~ #144, merged
      2026-08-24 (`f4936c3`, tag `v0.10.3`). Both write routes rename to the stored `projectState`
      and the search mapper's `|| p.status` fallback is gone. Scoped first and it was code-only:
      **0** of 393 rows carried `status`, 389 `projectState`, 4 neither — nothing to migrate.
- [ ] **3.6 F17 registry work, in order:** (a) write up the Track-feed ASK, do not build — `GET
      /api/v1/projects` on epictrack-api is unpaginated and serves `epic_guid`, but auth needs a
      Keycloak `eao-epic` JWT with the `view` role, audience `epictrack-web`; the credential is the
      whole critical path (namespace `c8b80a` vs `c72cba` unconfirmed — DNS cannot settle it).
      (b) ~~`unlinked` flag + `/db/stats` count.~~ **Shipped in #138** — flag is
      `sourceSystem: 'eagle'` (`merge/project.js:246`), count is `unlinkedProjects`
      (`controllers/db.js:112`), 4 subtests. A literal field would duplicate a stored fact. (c) The push endpoint on DEMI and the eagle-api caller — **authenticated from
      the first commit** (the old webhook died for being unauthenticated), idempotent on `eagleId`;
      the eagle-api side has never been built. The push carries id + label for every List ref and
      `proponentId` + name. (d) Nightly reconcile + drift alarm modelled on
      `eagle-search/worker/full-sync.js:120-164` — the only way a lost hard-delete is ever caught
      (eagle-api `findOneAndDelete`, zero tombstones).
- [ ] **3.7 Delete the old `demi-*` indexes — BLOCKED, trigger is §4.8 prod soak signed off.** No
      soak criterion is defined anywhere; §4.3 plans to HOLD both sets through that soak. Storage is
      not the cost (Basic is flat-rate). Deleting destroys the rollback for the index cutover on the
      only extracted copy of ~1.13M chunks. Unchanged: nothing prunes them
      (`dataDeletionDetectionPolicy` null everywhere; deletes stay the application's job).
- [ ] **3.9 `content: retrievable: false` on the `chunks` index.** Dropped by the 2026-08-24
      condense and restored — it is OPEN, not deferred. Today the only thing keeping whole chunk
      text out of responses is the explicit `select` in `searchChunks` (pinned by a test): a
      convention, not a structural guarantee. **It now trades against semantic ranking**, which was
      not true when the item was written: `content` is the sole `prioritizedContentFields` entry of
      `chunks-semantic` (`azure/search/indexes/chunks.json`) and a semantic config's fields must be
      retrievable — that interaction is why the field flipped in the first place. So this is not
      "blocked on an in-VNet highlighting check" any more; it is retrievable-false OR semantic
      ranking (measured +0.064 recall@1, +0.074 MRR on 78 labels), and highlighting reads the same
      field. A field-attribute change is an index recreate + refill of 1,128,733 chunks, so it
      could only ever ride the same recreate as B4 (3.1).

- [ ] **3.8 Small, bundle opportunistically:**
      - Apply the eagle-search `sync.livenessProbe.enabled: false` chart change to `6cdc9e-test`
        (`helm upgrade`; rendered, not yet deployed). Acceptance: 0 restarts across > 6h15m.
      - [x] ~~`basicPublishingCredentialsPolicies allow=false` (scm + ftp).~~ #146 (`f25cdd4`).
        **DECLARED, NOT APPLIED** — CI never deploys infra, so SCM still accepts passwords until a
        hand `deploy-infra.sh test`. Read truth off `az resource show
        .../basicPublishingCredentialsPolicies/scm --query properties.allow`, never the template.
      - Delete `PREVIEW_GATE_PASSPHRASE` from bcgov/eagle-public and the two stale preview
        branches (value is burned; branches are still dispatchable into a world-readable env.js).
      - ~~5-char `RPROXY_PASSWORD`.~~ **Misfiled**: nowhere in eagle-demi, it is a repo secret on
        `bcgov/eao-nginx` (`deploy-to-test.yaml:157,159`). Track it there.
      - [x] ~~Page-cap `GET /api/boundaries`.~~ #147, merged 2026-08-24. Bounded the `fetchAll()`
        drain; saved ZERO bytes and never could — `_sql.js:97` already clamped and the corpus is 281
        rows. **Same 1000-row truncation as the Cosmos-fallback item below**: the unfiltered read is
        cross-partition + `ORDER BY`, and the SDK's `LegacyFetchImplementation.mergeHeaders` drops
        `x-ms-continuation`, so no token exists on that path at any size. It now answers
        `x-truncated: true` + `Cache-Control: no-store` and logs; `?type=` is single-partition and
        pages properly. Unreachable at 281 rows.
      - eagle-search `deploy-infra.sh` prod branch: next prod infra deploy re-PUTs appSettings over
        the rotated 64-char `INGEST_KEY` from whatever `EAGLE_SEARCH_INGEST_KEY` is exported —
        silent, production-breaking. Durable fix: Key Vault reference.
      - Pin `ref: ${{ inputs.version }}` on `eao-nginx/deploy-to-test.yaml:119` (prod already
        pinned); point rproxy probes at `/` instead of `/nginx_status`.
      - [x] ~~Cosmos-fallback search truncates at 1000 with no continuation token (reachable only
        when AI Search faults).~~ **"Only when AI Search faults" was wrong and it was the whole
        defect**: `hasCriteria` excludes `project`, so `&project=<id>&pageSize=500` with no
        `sortBy` — eagle-public's project tabs and DEMI's own registry — took the Cosmos read.
        Measured on staging, one project of 2,488 documents: pages 0-1 served 500 each, pages 2-4
        served **0, 0, 0**, `count` said 2,488 throughout; the same URL with `sortBy=-datePosted`
        served 500/500/500/500/488. 9 of 348 test projects are over 1000 documents. #148, merged
        2026-08-24 (`8777e35`), reviewer PASS. Fixed by
        routing every Document read to the index and deleting the Cosmos list branch and its
        second mapper; `pageSize > 500` on a bare Document list is now a 400 rather than a silent
        500-row page. Project keeps its Cosmos read (348 rows, and `getAllFull(1, 1000000)`).
      - [x] ~~**New, from that change**: no document LIST is a live read any more, so an unpublish
        hides the file at once but leaves the ROW listed for up to the indexer's `PT5M` pass.~~
        #149, merged 2026-08-24 (`af67934`), reviewer PASS — `aiSearch.writeAcls` merges
        `read`/`isPublished` into the index (never `mergeOrUpload`: a row the indexer has not created yet is not
        findable), best-effort, batched at the service's 1,000. **Two siblings the line did not
        name went with it, and they were the larger leak**: an unpublished PROJECT stayed findable
        by name, and its cascade left every child document listed — ~170 rows, 2,488 on the largest
        test project. The cascade now returns the ACLs it derived (`setAclForProject().rows`) so
        the index gets the intersection, not the project's array. Chunks stay out: chunk text is
        gated on a live Cosmos read of the parent document (`controllers/search.js:998-1014`), so
        writing the parent row through closes that window too. Metadata edits keep the `PT5M`
        window, as named in `controllers/search.js`.
      - strip the unused Cosmos index paths (wildfires spatial, projects
        composite, five scalar paths) with the next Bicep deploy; `src/swagger/swagger.yaml` is
        stale — not the contract; `azure/search/README.md:56-59` one-liner (ADDING a field is
        no-rebuild); grant `demi-cicd-test` what-if at RG scope (role
        `b9331d33-8a36-4f8c-b097-4f54124fdb44`, not ABAC-denied) and record the baseline-noise
        list (was archive F6, deleted — re-measure).

## 4. Prod promotion — ordered gates

Deploy source is a tag verified on test, per workspace rules. Everything below assumes §1-3's
hardening landed and soaked on test.

- [ ] **4.1 Stand up the prod estate.** `rg-demi-prod` holds 3 resources (search service + PE +
      NIC). Needed: plan, Function App, UAMI, VNet integration, PEs, DNS, observability, **a prod
      Cosmos account**, and blob storage if Phase 3b ships (`Storage Blob Delegator` on the
      identity or download links fail to sign — not implied by Data Contributor). No
      `main.prod.bicepparam` exists; `deploy-infra.sh` refuses prod by name. **Blocked on role
      assignments:** the template declares three, and no assignable role in this subscription
      carries `roleAssignments/write` (c4b0a8 ABAC) — needs a custom role or a human. Set
      `rateLimitMaxRequests` per the transport chosen.
- [ ] **4.2 Copy the corpus into prod Cosmos BEFORE demi-api answers a single prod query.** Cosmos
      is inside the chunk search path — no prod Cosmos means every chunk result withheld (fails
      closed, an empty 200). Reconcile counts first and record them with source + date (index says
      1,128,576; container says 1,128,733). Preserve `src/scripts/export-chunks-to-eagle.js` — the
      only tool that can repopulate chunks anywhere.
- [ ] **4.3 Coordinate the index names with the rollback path.** `eagle-search-api-prod` (the
      thing answering `/eagle-search` today) reads the `eagle-*` indexes **from
      `demi-search-prod`**. Either hold both index sets through the soak — verify the Basic 15 GB
      headroom, test measures ~4.1-4.3 GB per set — or repoint its three settings in the same
      change. Say which. (`eagle-search-prod` the service is genuinely idle and holds 39 MB, not
      the corpus — not a rollback target.)
- [ ] **4.4 One eao-nginx prod tag carrying the demi block AND the `nginx.epic.proxy.demi`
      value.** Prod runs v2.7.14, which predates the block; `values-prod.yaml` has no `demi:` key,
      so a chart-only deploy renders the localhost sentinel and `/demi-search/*` 502s. One tag, one
      deploy. Needs the human approval gate; watch the stale-`waiting`-run concurrency trap.
- [ ] **4.5 Cut an eagle-public prod tag containing #803** (the two null guards) — to both the pod
      chart and the AFD bundle, same tag. Without it a malformed envelope bounces visitors off
      `/projects`.
- [ ] **4.6 Prod observability.** Zero resources in `c4b0a8-prod`; `demi-api-prod` would start the
      OTel distro only if `APPLICATIONINSIGHTS_CONNECTION_STRING` is set. After the flip, search
      volume and errors live in App Insights and nowhere else — add a `report-uri` or a webtest
      that exercises a real search URL, or accept the gap explicitly. (Staging is fixed and
      retains telemetry; "the reason is logged" claims are real there now.)
- [ ] **4.7 Cost sign-off.** Prod plan + Cosmos + observability + PEs + a temporary second index
      set, against a budget already exceeded (~451/month vs 400).
- [ ] **4.8 The flip and the soak.** Same lever as test: one Mongo `Config` field,
      `SEARCH_API_PATH`, with `/eagle-search` kept answering in parallel — cutover and rollback
      are the same one-field update, no redeploy either way (commands were archive F5, deleted).
      Soak with the browser console open: `EventService.getError()` has zero subscribers, so
      defects show as an empty table + a console line, never a toast. Content search (chunks) has
      NO public UI route — exercise the endpoint directly. Expect result links to 404 for
      documents the target Mongo lacks until corpora align — corpus provenance, not a demi defect.

## 5. Needs a human, not code

- [ ] See the summariser in a browser (staff Keycloak login,
      `demi-frontend-test-…azurefd.net/summary`).
- [ ] Verify the scoped access tier end to end: create a `project:<id>` role on a test user,
      confirm the filter narrows against real data (the auth bug that made TIER.SCOPED unreachable
      is fixed in #15).
- [ ] Verify boundary rendering at the three frontend fidelities.
- [ ] Eyeball server-side highlighting (long fields render as windowed fragments joined by
      ellipses).

## 6. Deferred — with the reason, so nobody re-opens them blind

- `pageNumber` citations: nothing cites; needs host + wire + API changes + re-extraction, and
  ~1,496 source PDFs 404.
- Intake-cleaner backfill: intake-only by design; ride the next re-extraction.
- OnPush conversion: change-detection rewrite with its own verification; lint rule stays off until
  then.
- Client-side highlighter: still backs the Cosmos fallback and map-explorer; deletable only if the
  fallback goes.
- Natural-language retrieval labels: needs a real query log, which needs retention — build from the
  first month of public logs.
- Tiled stratum stuck at 9 labels / no OCR stratum: no more renders to read without fetching PDFs
  that mostly 404.
- F12.10 eagle-public content pager offers ~10x too many pages: eagle-public fix (honour
  `countsPassages`), pre-existing against eagle-search, not a demi regression.
- Chunk paging ceilings (boundary-straddling `matchCount`, variable row count): inherent to
  stateless window grouping, pinned by tests; a fix is a contract change.
- F13 edge/WAF: prod's edge is the OpenShift router, so a Front Door rate-limit rule would key on
  shared egress — the defect it would exist to fix. rproxy's `limit_req` on `$binary_remote_addr`
  IS the per-IP control and is correct at today's edge. Revisit when the edge moves or DEMI's
  frontend stops calling the API directly. Never key on leftmost-XFF (attacker-controlled).
- `demi.eao.gov.bc.ca` DNS: filed with OCIO/NRIDS route in mind; long-lead; F5a exists so nothing
  waits on it. Exit plan (absolute `SEARCH_API_PATH`, CORS step, delete the nginx block, revert
  the rate ceiling) was archive F5a, deleted — re-derive before the exit.
- NRPTI: removed entirely 2026-08-07 (`952f5de`); the measured census the redesign was to start
  from went with the deleted archive. Only shared-project records matter, linked by `_epicProjectId`;
  `?populate=true` works; the documents are mostly already in DEMI.

## 7. Standing rules and ceilings — do not re-derive

- **A probe that cannot fail proves nothing.** Every corpus row is public until the scoped key
  exists, so only synthetic tests discriminate ACL behaviour. Take a BEFORE reading; caps can fake
  a pass; use nonsense terms to detect fallback.
- **The predicate trap** (every reviewer finding two sessions running): a predicate chosen by
  reading one code path, then tested only against that path. Enumerate every shape the field takes
  first. Corollary: a test that mocks the call site asserts a shape production cannot produce.
- **Index-change deploy order, not negotiable** (`azure/search/README.md`): index PUT → datasource
  PUT **by hand** (the apply script never writes one; on staging the `DIFFERS` warning cannot
  fire — the package ships no datasource files, verify the live `container.query` directly) →
  backfill → indexer reset + run → app last. App first = 400s answered as 502s to anonymous
  callers.
- **OData has no `false` literal** — a null/empty filter is UNRESTRICTED; every search route must
  honour the `empty` flag; the structural coverage test cannot see a route that forgets it.
- **`_ts` advances on ANY write** and the indexers see no deletes — datasource SELECT first,
  always; `deleteFromIndex`/`deleteChunksForDocument` are forever the app's job.
- **appSettings is a whole-collection PUT.** OpenShift (`demi-app-secrets`) is the source of truth
  for every deployed credential; never round-trip secrets out of the live app; never add `''`
  defaults to bicepparam.
- **App Service**: `restart` does not recycle the Node worker (stop/start, then poll a
  discriminator); ~50 s cold start; chunked request bodies dropped; 240 s request timeout; verify
  deploys by content via Kudu VFS, never mtime; zipdeploy async + poll status (3=FAILED,
  4=SUCCESS).
- **`/db/stats` counts three containers, not `chunks`**, and its latency proves nothing —
  discriminate by payload (`driver: azure-cosmos-nosql` / `database: demi`).
- **Temporary search-service grants**: Search Service Contributor at service scope, revoke
  immediately after, verify the identity is back to exactly Search Index Data Contributor. ABAC
  here denies write AND delete only for the same six role GUIDs — anything else is grantable and
  revocable.
- **Where demi is deliberately STRICTER than eagle-search — do not "fix" toward eagle:** unknown
  params 400; `pageSize>500` refused; `read[]` withheld from rows; keywordless chunk search
  returns 0; chunk paging loses 0 documents.
- **Decided, do not redo:** the 4 `js/path-injection` alerts (multer's own paths); helmet CSP off
  (API serves only swagger-ui); the rate limiter is proven (draft-7 monotonic decrement across
  connections — do not re-verify with a 300-request run); facets are computed over the filtered
  set and are NOT the vocabulary source; filter values stay List ObjectIds, not labels (`name`
  ambiguous in 39/149 vocabulary rows); chunk rows are always grouped by document.
- **Keep comments short; long explanations belong in a doc.** Standing, 2026-08-24. Several files
  here carry 15-25 line comment blocks re-arguing a decision — `src/controllers/search.js` worst.
  A comment says what the code cannot: the non-obvious why, in a line or two. Anything longer is a
  technical document (wiki, ADR, or `docs/`), linked from a one-line comment. Watch for this while
  developing, and trim on the way past — a rambling comment is drift, not documentation.

- **Cost shape:** AI Search 41%, Defender 28% of RG spend — standing charges, application tuning
  cannot move them. Summariser is per-token (~0.0023 CAD/query measured); watch logged p95, and
  re-check rates when the model or SKU changes.

## Out of scope

`rg-epic-search` shares the billing group, not the ownership — do not investigate or track it
here. The eagle-search fold is the one deliberate exception to scope: it reaches into
`eagle-search`, `eagle-public`, `eao-nginx` and `6cdc9e-test`/`-prod` because DEMI is taking over
a capability they own; that coupling ends when eagle-search is archived.
