# TODO

Open work only. Facts, measurements and history live in the
[wiki](https://github.com/digitalspace/eagle-demi/wiki); if something here needs a paragraph of
background, that background belongs there and this entry links to it.

Dev only. `main` is deployed and current as of 2026-08-04.

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

## NRPTI ingest

- [ ] **NRPTI auto-seeds projects that are not projects, and nothing ever removes them.**
      `src/scripts/sync-nrpti.js` tries five ways to link a compliance record to an existing project
      (`_epicProjectId`, exact name, normalized name, name segments, token inclusion) and then, at
      Priority 4, **invents one** from `item.projectName || item.location` — a synthetic id
      `8000000 + hash(name) % 1000000`, `projectState: 'Compliance Record Ingest'`, a centroid
      hardcoded to Victoria, and `read: ['public', …]` so it is publicly listed like a real project.
      Many of those names are facilities, locations or record titles, not EPIC projects, so the
      registry gains rows that no project ever existed for.
      The fix is to delete Priority 4: link only when Track or Eagle already has the project, and
      leave the record unlinked otherwise. Two things must be decided at the same time, because both
      are load-bearing:
      - **What an unlinked record becomes.** Today the no-name path writes `projectId: ''`, which is
        the empty-string partition — reachable by no scoped read, so the record is ingested and then
        invisible. Either that is accepted deliberately (an unmatched-records bucket someone can
        query) or unmatched records should not be written at all. Do not leave it as an accident.
      - **The link is not free to change later.** `projectId` is the records container's PARTITION
        KEY, so re-pointing a record at the right project is a delete plus an insert, not an update.
      - [ ] **Purge the seeded stragglers**, which is a separate job from the gate: a script over
            `metadata.seededFromNrpti === true` / `sourceSystem === 'nrpti'` that deletes the project
            AND calls `aiSearch.deleteFromIndex` for it. Indexers never see deletes — drop that
            second half and the phantom projects stay searchable forever even once Cosmos is clean.
            Then re-point or drop the records that referenced them.
      Measured 2026-08-05, and the measurement is thin: `/api/projects` returns 382 rows, all
      `sourceSystem: 'track'`, and the first 250 rows of the `demi-projects` index carry no synthetic
      id — so under PUBLIC access, on dev, there is nothing to purge right now and the gate is what
      actually matters before the next `POST /admin/sync/nrpti`. That read cannot see past ACLs and
      the list endpoint ignores `pageNum`, so it is not proof the containers are clean. Count with
      `systemAccess()` before concluding the purge is a no-op.

## Infrastructure

- [ ] **CodeQL's first scan found 39 alerts (36 high, 3 medium). Three clusters, not 39 problems.**
      The 3 medium were `actions/missing-workflow-permissions` on `pr.yaml` and are already fixed —
      it now declares `permissions: contents: read`. What is left:
      - **~30 x `js/missing-rate-limiting`** across `src/routes/api.js` and `src/app.js:126`. One
        root cause, one fix: there is no rate limiter mounted on the Express app at all. An
        `express-rate-limit` on the router closes the whole cluster. Worth doing on its own merits —
        `/api/search` fans out to Azure AI Search on debounced keystrokes, and Basic tier allows 2
        concurrent semantic requests per search unit.
      - **`js/insecure-helmet-configuration`** at `src/app.js:41` — helmet is mounted with
        `contentSecurityPolicy: false`. Decide whether the frontend can live under a CSP; if it can,
        turn it on, and if it cannot, dismiss the alert with that reason rather than leaving it open.
      - **`js/incomplete-multi-character-sanitization`** at
        `frontend/src/app/services/registry-state.service.ts:1707`. Read it before judging — a
        partial sanitizer is worse than none because it looks handled.
      - **4 x `js/path-injection`** in `src/controllers/nosql/document.js` (171, 177, 189, 220) are
        **false positives** — every one is `fs.promises.unlink(file.path)`, and `file.path` comes
        from `multer({ dest: config.uploadDir })`, which generates its own random filename and never
        derives it from `originalname`. Dismiss as "used in tests"/"false positive" with that note so
        they stop reappearing; do not "fix" them.
- [ ] **Angular 19 is end-of-life and carries 7 unfixable advisories.** `frontend/package.json`
      resolves `@angular/*` to **19.2.25**, the newest 19.x, and every one of the 7 open Dependabot
      alerts on `@angular/core`, `@angular/common` and `@angular/compiler` has
      `first_patched_version: null` with a vulnerable range of `<= 19.2.25`. There is nothing to
      upgrade to inside 19 — angular.dev lists v22 active, v21 LTS, v20 LTS to Nov 2026, and "v2 to
      v19 are no longer supported". `first_patched_version: null` means "no fix in the affected
      major", not "no fix anywhere": Dependabot's first run proposed 20.3.x as ordinary **version**
      updates (PRs #33/#34/#40, all closed) and every one failed `Test & Build Frontend`, which is
      the evidence that this is a migration and not a bump. `.github/dependabot.yml` now freezes the
      whole toolchain — `@angular/*`, `@angular-devkit/*`, `@angular-eslint/*`, `angular-eslint` and
      `zone.js` — because those are version-locked to each other: PR #42 bumped only
      `@angular-devkit/build-angular`, to 21.2.19, and the build died on "`@angular/build` supports
      Angular versions ^21.0.0, but detected Angular version 19.2.25 instead". **Deleting that
      `ignore:` block is step one of the upgrade.** Framework and toolchain have to move in one
      commit; a half-upgraded pair does not build at all.
      **The Angular freeze is now what holds the remaining alerts open.** As of 2026-08-06 there are
      33, all in `frontend/yarn.lock`: 7 runtime (the Angular set below, unfixable) and 26
      development-scope in the build toolchain, which cannot move while `@angular-devkit/*` is
      pinned to 19. None of them ship — only `frontend/dist` is deployed, never `node_modules` — so
      this is a CI supply-chain exposure, not a production one. The upgrade clears both groups at
      once.
      They are not theoretical: XSS via i18n event-handler attributes, hydration DOM clobbering and
      response-cache poisoning, `HttpTransferCache` cache-key ambiguity, and a DoS via OOM in date
      formatting — all in code the bundler compiles into what `demi-frontend-dev` serves.
      **Target 21** (LTS to ~Nov 2027) rather than 22; `eagle-public` in this workspace already runs
      Angular 21, so there is a migration to copy rather than invent. Two majors, so it is real work
      and not a dependency bump. Until it happens the open-alert floor is 7 — a count below that
      means somebody dismissed an alert instead of fixing it.
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
- [ ] **`MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `TYPESENSE_API_KEY`, `OPENSHIFT_TOKEN` and
      `OPENSHIFT_URL` are now unreferenced repo secrets.** The two `MINIO_*` were read only by the
      deleted test/prod workflows, as Bicep parameters; `TYPESENSE_API_KEY` outlived Typesense
      (deleted 2026-07-31) and `OPENSHIFT_*` predate the move off OpenShift entirely. Nothing in
      `.github/workflows/` references any of them — confirmed by grep, not assumed. They are live
      credentials sitting in a **public** repo's settings, reachable by any workflow that asks, so
      the decision is delete-and-rotate rather than leave-and-forget. MinIO itself is still in use at
      runtime; those values come from Azure app settings, not from here.
- [ ] **`demi-identity-dev` briefly held Website Contributor on `demi-api-dev`** (assignment
      `29745ac3`, 2026-08-05, removed same day). Worth knowing that
      `Microsoft.Authorization/roleAssignments/delete` is denied at this RG even though *create*
      succeeds — the `permissions` API reports `actions: ["*"]`, `notActions: []`, which is
      misleading. Removing a role assignment needs someone with more rights.
- [ ] **Phase 3b, blob storage.** Code and Bicep written, nothing deployed or copied; wired into
      `main.bicep` behind `deployDocumentStorage`, which defaults false. The argument is
      per-environment isolation, not cost. Needs `Storage Blob Delegator` on the identity or every
      download link fails to sign — it is not implied by `Storage Blob Data Contributor`.
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
      nothing else had to change. Watch that `select`.
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
      neither `demi-logs-dev` nor `demi-insights-dev`, only the portal-created orphan
      `workspace-c4b0a8devrgYb8e` that `azure/modules/observability.bicep` was written to replace.
      That module has never been deployed, because `main.bicep` has never been deployed.
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

- [ ] **Facets are NOT blocked — the reason recorded here was wrong.** `sector`, `region` and
      `status` on `demi-projects` are already `facetable: true`, as is every field in both metadata
      indexes; see `azure/search/indexes/`. This entry previously said they needed a reindex because
      `facetable` is not a mutable field property. True in general, moot here: the fields were
      created facetable. What remains is a `facets` parameter on the query and UI to render the
      counts — the sector chips are still a hardcoded list of four with no count per value.
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
- [ ] **Verify scoped and fragment access tiers end to end.** The reason this was never observed is
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
- [ ] **Delete the 12 merged branches on `origin`.** From PRs #1–#10, #12 and #13.
      `git push --delete` is barred by settings deny, so this needs a human or the GitHub UI.

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
| 1 | Backup mode `Continuous7Days` on dev | Not done | One-way. Gain 8h/support-ticket → 7-day self-service, free tier; lose Geo backup redundancy permanently |
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
