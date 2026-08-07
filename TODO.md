# TODO

Open work only. Facts, measurements and history live in the
[wiki](https://github.com/digitalspace/eagle-demi/wiki); if something here needs a paragraph of
background, that background belongs there and this entry links to it.

Dev only, and dev deploys itself: a merge to `main` runs `azure-deploy-dev-api` and
`azure-deploy-dev-frontend`, so what is on `main` is what is on dev within a few minutes. There is
no date to keep current here — read the workflow runs. At the time of writing that is `16ac528`
(API) and `0d0dde0` (frontend), 2026-08-07.

The corollary is the trap: **merging is deploying.** An entry below is live the moment it lands,
including one whose infrastructure does not exist yet — see service credentials under
Infrastructure.

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

The auto-seed is gone from the code. What is left is operational: nobody has run the purge or the
first gated sync against dev.

- [x] **NRPTI no longer invents projects — Priority 4 deleted 2026-08-06.**
      `src/scripts/sync-nrpti.js` used to fall through its five linking strategies and **create** a
      project from `item.projectName || item.location`: synthetic id `8000000 + hash(name) % 1000000`,
      `projectState: 'Compliance Record Ingest'`, a centroid hardcoded to Victoria, and
      `read: ['public', …]` so it listed publicly beside real Track projects. Many of those strings
      are facilities, locations or record titles. Track owns the registry; a sync does not add to it.
      The ladder is now `resolveProjectLink()` — pure, exported, and unit-tested one case per
      priority. **An unmatched record is dropped, not written.** There is no `projectId: ''` bucket:
      the run logs the skip count and the top 20 unresolvable names, and that log is the only record
      of them. `simpleHash` went with Priority 4.
      Correcting the reason this entry used to give: the empty-string partition was *not* invisible.
      `scopeClause` restricts on the partition key for `TIER.SCOPED` only, so `GET /records` with no
      `project` param returned unlinked records to an anonymous caller. They were unreachable by
      scoped reads and by `/records?project=X`, not by everyone.
- [x] **`records.buildCriteria` treated `projectId: ''` as "no filter".** Found while writing the
      purge. A falsy `if (projectId)` meant asking for the unlinked partition returned the WHOLE
      container — so the sweep below would have deleted every compliance record. Both the criterion
      and the `partitionKey` are presence tests now, with a repository test asserting the SQL.
- [ ] **Run `purge-nrpti-seeded.js` on dev, then re-sync.** The script exists and is tested; nothing
      has been executed. Dry run by default, `--live` to delete, and it must run INSIDE the app
      container over the SSH tunnel because Cosmos is private-endpoint-only and keyless. Per seeded
      project it deletes the records first, then the project, then calls
      `aiSearch.deleteFromIndex(indexes().projects, id)` — that last call is the point, because
      indexers work off a `_ts` high-water mark and never see deletes, so skipping it leaves phantom
      projects searchable forever even once Cosmos is clean. It refuses any project that owns
      documents, and leaves alone anything carrying `sourceSystem: 'nrpti'` without
      `metadata.seededFromNrpti`. It also sweeps the `''` partition.
      Deleting the records is required rather than tidy: `projectId` is the partition key, so a
      re-sync that re-ingests the same NRPTI `_id` under a different `projectId` writes a NEW item
      and orphans the old one.
      Measured 2026-08-05, and the measurement is thin: `/api/projects` returns 382 rows, all
      `sourceSystem: 'track'`, and the first 250 rows of the `demi-projects` index carry no synthetic
      id. That read cannot see past ACLs and the list endpoint ignores `pageNum`, so it is not proof.
      **Count with `systemAccess()` first** — `projectsRepo.listBySourceSystem(systemAccess(), 'nrpti')`
      — and that count is also what decides the `ponytail:` note in `sync-nrpti.js`: the
      seeded-projects-last `sort()` is dead the moment the purge reports 0, and should be deleted then.
      After the purge, `POST /admin/sync/nrpti?async=true` and read `totalUnlinked` from the
      `Background NRPTI sync complete` log line — the async response cannot carry it. A seeded
      project appearing after that means Priority 4 came back.
      **A `--live` run refuses to start at all if AI Search is not configured**, before deleting
      anything: `deleteFromIndex` returns `0` for a failed delete and for an unconfigured service
      alike, so without that gate an unconfigured environment would empty Cosmos and only then
      report one failure per project — and none of them retryable, because `listBySourceSystem`
      cannot return a project Cosmos no longer holds. A dry run is still allowed without it, since
      it writes nothing.
      An index delete that fails is a `stage: 'index'` failure and exits 1, for the same
      no-retry reason. Delete that id from `demi-projects` by hand if it appears.
      Record counts are deletions, not attempts: `cosmos.remove` answers `false` on a 404 and the
      summary only counts a `true`.
- [ ] **A dropped record is never revisited by a delta sync.** `since` is caller-supplied, so once
      `resolveProjectLink()` returns null for a record it stays out of Cosmos even after Track adds
      the project its name would now match. Only a full `since`-less `POST /admin/sync/nrpti`
      re-ingests it. Run one after any batch of new Track projects, or the compliance history for
      those projects starts at the sync date rather than at the record dates.
- [ ] **`documents.buildCriteria` still treats `projectId: ''` as "no filter"** (`documents.js:20`,
      and the `partitionKey` at `:45`) — the same shape as the records bug fixed above. Not live:
      no caller passes `''` and nothing sweeps a documents `''` partition. Worth aligning before
      something does. `records.getById`'s falsy `projectId` is fine by contrast — it degrades to an
      ACL-gated cross-partition query, not a wider result set.

## Infrastructure

- [ ] **38 CodeQL alerts open on `main`, all high — and 37 of them are two decisions, not 37
      problems.** Counted 2026-08-07, after #59–#65:
      31 `js/missing-rate-limiting`, 4 `js/path-injection`, 1 `js/insecure-helmet-configuration`,
      1 `js/clear-text-logging`, 1 `js/insufficient-password-hash`. The 3 medium
      `actions/missing-workflow-permissions` from the first scan are fixed — `pr.yaml` declares
      `permissions: contents: read` — and `js/incomplete-multi-character-sanitization` is closed by
      the fix recorded below. **Only the rate-limiting cluster is real work**; every other alert
      here is decided-and-dismissible, listed under "Needs a human".
      - **31 x `js/missing-rate-limiting`** across `src/routes/api.js` and `src/app.js:126` — up
        from ~30 because #60 added the `/admin/api-keys` routes, and it will keep tracking the route
        count until this is fixed. One root cause, one fix: there is no rate limiter mounted on the
        Express app at all. An `express-rate-limit` on the router closes the whole cluster. Worth
        doing on its own merits — `/api/search` fans out to Azure AI Search on debounced keystrokes,
        and Basic tier allows 2 concurrent semantic requests per search unit.
      - **`js/insecure-helmet-configuration`** at `src/app.js:41` — helmet is mounted with
        `contentSecurityPolicy: false`. **Decided 2026-08-06: dismiss, do not implement.** The
        question was "can the frontend live under a CSP", and the answer is that the API does not
        serve the frontend at all — the `express.static` mounts and SPA routes that suggested it did
        are deleted (see below). What is left is exactly one HTML page, swagger-ui at `/api-docs`,
        whose inline initializer script and inline styles a default CSP blocks. A policy that
        exempts the only page it covers protects nothing, so this is dismissed with that reason
        rather than implemented — see "Needs a human".
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
        derives it from `originalname`. Dismiss as "used in tests"/"false positive" with that note so
        they stop reappearing; do not "fix" them.
      - **`js/clear-text-logging`** at `src/scripts/copy-blobs-to-azure.js:146` — also a **false
        positive**, and it was missing from this entry rather than newly appeared. The line is
        `console.log('Destination:', JSON.stringify(azure.describe()))`, and `describe()`
        (`src/storage/azureBlob.js:133`) returns `{backend, account, container, keyPrefix: null}` —
        resource names, no credential. CodeQL flags it because `config.*` reaches a log sink, not
        because a secret does.
      - **`js/insufficient-password-hash`** at `src/helpers/api-key.js:31` — **new with #60, and a
        false positive.** The digest is SHA-256 over 32 bytes of `crypto.randomBytes`, not over a
        human-chosen password. A KDF exists to make guessing a low-entropy secret expensive; there
        is nothing to guess here, so bcrypt/argon2 would buy nothing and add latency to every
        authenticated request. What matters is that the compare is constant-time, which
        `api-key.js:verify` does with `timingSafeEqual`. The reasoning is already in that file's
        header — dismiss with it.
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
- [ ] **Service credentials are LIVE on dev and cannot work: the `apikeys` container does not
      exist.** #60 shipped per-consumer registry keys — `X-Api-Key: demi_<env>_<keyId>_<secret>`,
      minted through `POST /admin/api-keys`, with their own roles, expiry and revocation — plus the
      `demi-service-read` read-only tier and `requireWrite` on every mutating route. All of that is
      deployed, because a merge to `main` deploys dev. But `src/repositories/api-keys.js` reads a
      Cosmos container called `apikeys` that is declared **only** in
      `azure/modules/cosmos-nosql.bicep`, and that template has never run — see the entry below,
      which is deliberate and does not change for this. So today `POST /admin/api-keys` throws on
      the upsert and every registry-format key 401s.
      **This is not a code fix and it is not a reason to deploy `main.bicep`.** Container creation
      is a control-plane call: create `apikeys` on `demi-cosmos-dev`, database `demi`, partition key
      `/id` — the id IS the public keyId, which is what makes verification a single-partition point
      read on the hot path of every keyed request. The Bicep declaration exists so the template
      keeps describing dev accurately, not as the delivery mechanism.
      Nothing is broken while it is missing: `ADMIN_API_KEY` still authenticates, and that
      break-glass path is exactly how the first registry key is meant to be minted anyway. It is
      checked BEFORE the registry branch so a key-shaped `ADMIN_API_KEY` cannot shadow it.
      **The documentation for this is unpushed.** `README.md` on `main` links
      `ADR-007-Service-to-Service-Credentials` and `Connecting-an-Application-to-DEMI`; the wiki's
      local HEAD is `beb585b` and its remote is `f63d794`, so both links 404 for everyone right now.
      ADR-007 already carries the out-of-band container note. Push the wiki.
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
- [ ] **Dismiss 7 CodeQL alerts in the GitHub UI** — every open alert except the rate-limiting
      cluster. Each is decided rather than deferred, and leaving them open reads as work nobody got
      to; the reasons are all in the Infrastructure entry above, one line each:
      - `js/insecure-helmet-configuration` — the API serves exactly one HTML page, swagger-ui at
        `/api-docs`, which needs inline script and style, so a CSP would have to exempt the only
        page it covers.
      - 4 x `js/path-injection` — `fs.promises.unlink(file.path)` where multer generated the name.
      - `js/clear-text-logging` — the logged object is `{backend, account, container}`, no secret.
      - `js/insufficient-password-hash` — SHA-256 over 32 CSPRNG bytes, not a password; the compare
        is `timingSafeEqual`.
      Dismissing these takes the open count from 38 to 31, and then the number means something: it
      is the rate-limiter cluster and nothing else.
- [ ] **Delete the 21 branches on `origin` whose PRs are merged, and stop it recurring.** It was 12
      (PRs #1–#10, #12, #13); #59–#65 added 7 more. The recurrence is one setting —
      `delete_branch_on_merge` is **false** on this repository — so flip that first and the list
      stops growing while the backlog is cleared. `git push --delete` is barred by settings deny, so
      the deletions need a human or the GitHub UI.
      Count it with `gh pr list --state merged` intersected against `git ls-remote --heads`, never
      `git branch --merged`: these are squash merges, so a merged branch's tip is not an ancestor of
      `main` and `--merged` reports 1.

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
