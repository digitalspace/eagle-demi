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
| **Deliberately not doing it** | `pageNumber` citations; ~~result paging~~ (now required — F3); the client-side highlighter; the intake-cleaner backfill; the OnPush conversion; ~~natural-language labels~~ (now measurable — real query log arrives with the fold); the tiled/OCR strata; ~~the 402 monthly rollover~~ (F1's `alwaysOn` makes the worker long-lived); `content: retrievable` |
| **The eagle-search fold** | Everything in "The eagle-search fold" below. F0 is settled and F1's "missing double-gate" turned out not to exist (the cascade already ships), so the remaining gate is F3's contract work. Transport is NOT a gate: F5a proxies through rproxy while the DNS request for `demi.eao.gov.bc.ca` is outstanding |

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

## The eagle-search fold — demi-api becomes the query layer

Plan: `/root/.claude/plans/so-what-is-next-atomic-wombat.md`. That file is the reasoning; this
section is the work. **This section is the source of truth during execution** — work top to bottom,
do not start a group whose blocking predecessor is unticked, append newly discovered work here
*before* doing it, and strike a wrong line through with a one-line reason rather than deleting it.

What it is: eagle-public's Project, Document and DocumentChunk search moves from `eagle-search` to
`demi-api`, called **direct from the browser, cross-origin**, and eagle-search retires. It is a
build, not a cutover — demi-api is missing features eagle-public depends on, and prod has no DEMI
to fold into.

**It changes the premise under a dozen entries elsewhere in this file.** "Nobody uses DEMI yet" stops
being true; DEMI starts serving anonymous public search on a `.gov.bc.ca` origin. Those entries are
struck through in place with a pointer here.

### F0. Decision gate — the project id-space

- [x] **Decide how demi-api identifies a project to eagle-public.** ~~Nothing below F0 is worth
      building until this is settled.~~ Settled — see DECIDED below.
      **Narrower than it first looks — it is PROJECTS only.** `src/seed/transform.js:84-87` sets a
      document's `id` to `String(doc._id)`, the Eagle ObjectId ("the Eagle _id is the stable natural
      key"), and chunks carry `documentId` referencing that same id
      (`azure/search/datasources/demi-chunks-ds.json:11`). So the chunk→document join is *already*
      in Eagle id-space. What is not: `projectId` on documents and chunks, and `_id` on project rows
      (`src/controllers/search.js:104-109` maps `_id: String(doc.id)` — the DEMI/Track id).
      **Also correct the field name before anyone greps for it:** the Cosmos field is **`eagleId`**
      (`src/repositories/projects.js:87-91`). `legacyEagleId` exists only as a datasource projection
      alias — `azure/search/datasources/demi-projects-ds.json:11` selects `c.eagleId AS
      legacyEagleId` — plus the index field and the response field.
      - **(a) Eagle-compatible response mode**, on a query param or a separate route, so DEMI's own
        frontend keeps the Track id. **Recommended, and cheaper than it looks:**
        `src/merge/project.js:227-236` builds Eagle-only projects as ``id: `eagle-${eagleId}` ``, so
        for those rows recovering the Eagle id is a prefix strip, not a lookup. And `:171` shows the
        null case is Track-sourced projects (`eagleId: hasValue(track.epic_guid) ? … : null`) —
        projects Eagle never had, which eagle-public could not link to anyway.
      - **(b) Backfill `eagleId` to non-null, then return it unconditionally.** Cleaner steady state,
        but it is a Cosmos backfill *plus a reindex of all three indexes*, and it collides with F4's
        create-and-refill. Materially bigger than "backfill a field".
      **DECIDED 2026-08-22 — option (a), eagle-compatible response mode.** Verified in source, not
      inferred:
      - **The Eagle id is already a field on project rows, on both merge paths.**
        `src/merge/project.js:171` sets `eagleId: hasValue(track.epic_guid) ? String(track.epic_guid)
        : null` for Track-sourced projects, and `:229-231` sets `eagleId` (and
        ``id: `eagle-${eagleId}` ``) for Eagle-only ones. So the eagle-compatible `_id` is a field
        rename in the response mapper, not a lookup and not a backfill.
      - **The nullable case is projects Eagle never had** — Track rows with no `epic_guid`. Those
        have no Eagle route to link to, so omitting them from an eagle-shaped response loses nothing
        eagle-public could have rendered.
      - **Documents and chunks need no work at all.** `src/seed/transform.js:84-87` already sets a
        document's `id` AND `eagleId` to `String(doc._id)`.
      **What option (a) still has to solve, and how — this is the part F3 must build:**
      `projectId` on documents and chunks is the **DEMI** project id.
      `azure/search/datasources/demi-documents-ds.json:11` selects `c.projectId`, and
      `azure/search/indexes/demi-documents.json` carries exactly
      `[id, displayName, documentFileName, description, type, projectId, read, isPublished]` — no
      eagle project id and **no project name**. So both eagle-public's `&project=<EagleObjectId>`
      filter and its `rowData.project.{name,_id}` binding miss.
      **Translate at query time rather than reindexing.** demi-api resolves the incoming Eagle
      ObjectId to the DEMI project id before building the filter, and decorates rows from the same
      map on the way out. It is ~382 projects — one cached in-memory map, refreshed on a TTL. That
      keeps this off F4's create-and-refill, which is the collision option (b) would have caused.
      **Rejected: option (b).** The field is `eagleId` in Cosmos, so "backfill `legacyEagleId`" is
      really a Cosmos backfill **plus a reindex of all three indexes**, and it collides with F4.
      **Acceptance:** F3's envelope and row-shape entries cite this decision. Done — F3 is unblocked.

### F1. Preconditions — none of the rest is safe without these

- [ ] **CORRECTED 2026-08-22 — the defect as written DOES NOT EXIST, and this is not a blocker.**
      A blanket downward cascade already ships: `src/controllers/nosql/project.js:186-206` calls
      `documents.setAclForProject(systemAccess(), id, acl.read)` on the transition to private, which
      bulk-Patches `/read` and `/isPublished` across the whole `/projectId` partition
      (`src/repositories/documents.js:155-181`). Chunks are deliberately excluded — a chunk is gated
      on its parent document in the chunk-search join, per the `ponytail:` note at `:182-185`.
      **§1b below is stale inside its own PR.** Commit `7a9c437` (#80, 2026-08-12) contains both the
      commit that wrote §1b and, later in the same squash, `fix(access): restrict documents when
      their project unpublishes`, which closed it. §1b was never re-edited. **Nothing gates the
      cutover on this.**
      **It is still worth doing, for four reasons §1b does not give**, and it stays here as ordinary
      work rather than a blocker: the cascade is **destructive and one-way** — it overwrites each
      document's own `read[]`, so re-publishing the project restores nothing, which is §1b's own
      argument against a blanket cascade; it is **best-effort at write time**, and a partial failure
      leaves documents public behind a 500 and a log line nothing retains; and a denormalised
      ceiling is lossless where the cascade is not.
      **Three ordering constraints, one of them one-way and worse than the one §1b names:**
      (a) `demi-documents-indexer` is a PT5M `_ts` high-water mark. A backfill that touches
      `/updatedAt` advances `_ts` on all ~60,578 rows and makes the indexer re-pull the corpus — if
      the datasource SELECT does not already carry `c.projectIsPublished` at that moment, the
      high-water mark moves past them permanently. Datasource first, always.
      (b) `filterFor` is shared across all three indexes, and `demi-projects`/`demi-chunks` have no
      such field — naming a missing field in an OData filter is a **400, not an empty result**. The
      ceiling must be an opt-in third argument, mirroring how `access-sql` takes `opts.unsetIsPublic`
      for boundaries only.
      (c) Removing `setAclForProject` and adding the read predicate must ship in the **same**
      release. Either order across two releases reopens a hole or keeps the lossiness.
      **And the tests that pin the current behaviour become wrong invariants** —
      `test/controllers/nosql-controllers.test.js:771-836` asserts the cascade's ACL equality.
      `7a9c437`'s own message names the pattern: *"The test that pinned the old behaviour was
      pinning the bug."*
      ~~ORIGINAL CLAIM, now known false:~~ eagle-search enforces "public sees a document only if
      the document AND its parent project are public" by intersecting `read[]` with the parent's at
      index time and re-stamping chunks from the parent document. demi-api does the opposite — see
      **§1b, "Unpublishing a project cascades to nothing"** below: `resolveDocumentAcl` checks the
      parent only when a document is WRITTEN, and nothing re-evaluates it.
      **So retiring eagle-search moves the public search of `projects.eao.gov.bc.ca` onto a query
      layer that lacks a gate the retiring one had.** §1b is already designed and decided
      (denormalise `projectIsPublished`, `visible = read[] matches AND (projectIsPublished OR
      privileged)`); it is now a hard precondition of any `SEARCH_API_PATH` flip, including its
      ~60,578-row backfill and its ordering trap (`c.projectIsPublished = true` against an undefined
      field is NOT true — backfill first, or ship
      `(NOT IS_DEFINED(c.projectIsPublished) OR c.projectIsPublished = true)` and tighten after).
      **Acceptance:** a project unpublished *after* its documents were written no longer returns
      those documents to an anonymous `/api/search?dataset=Document` — demonstrated, not reasoned.
- [ ] **BLOCKED: mint the scoped service key BEFORE the flip, not as a parallel cheap win.** §1
      already carries "Mint the first real service key", and the audit records that *no live probe
      against this corpus can fail* because every row in dev is public. The fold puts a
      public-internet search onto that ACL, so verifying it afterwards with a probe that cannot fail
      is the exact failure mode this repo has already paid for twice. Move it ahead of F5.
- [ ] **Custom domain for demi-api under `.gov.bc.ca` — long-lead, file it now, but F5a means
      nothing waits on it.** The name is already chosen in the dev-guides wiki
      (`Search-Cutover.md:396`): **`demi.eao.gov.bc.ca`**. That entry also names an Entrust OV
      certificate as a long-lead item — **that half does not apply here**: a CNAME to Azure gets App
      Service's free managed cert. The Entrust cert is only needed if the name is A-recorded at
      rproxy instead.
      This is what makes the CSP a non-event: both policies that matter are
      `connect-src 'self' https://*.gov.bc.ca` — the pod bundle's (`eagle-public/Dockerfile:117`)
      and Front Door's (`eagle-public/azure/main.publicprod.bicep:203`). Both cover
      `https://demi-api-test.projects.eao.gov.bc.ca`; **neither covers
      `https://demi-api-test.azurewebsites.net`.**
      **There is no precedent and no self-service path.** Every App Service and Function App in both
      subscriptions carries only `<name>.azurewebsites.net` + the SCM host. There is no Azure DNS
      zone in `c4b0a8-test` or `c4b0a8-prod`. `eao.gov.bc.ca` is **not delegated** — it is a flat
      record set inside BC Gov's central zone (same NS as `gov.bc.ca`, no separate SOA), and
      `projects.eao.gov.bc.ca` is an A record to the Silver router VIP. **`az` cannot write there.**
      The human step is a DNS change request to BC Gov central DNS (OCIO/NRIDS), the same route that
      created `projects.eao.gov.bc.ca`. Raise it on day one; everything else can proceed in parallel.
      Records to request:
      ```
      demi-api-test.projects.eao.gov.bc.ca.        CNAME  demi-api-test.azurewebsites.net.
      asuid.demi-api-test.projects.eao.gov.bc.ca.  TXT    "<customDomainVerificationId>"
      ```
      The TXT value, read 2026-08-22 (it is a per-subscription verification id, not a secret):
      ```
      130FC078BDA27E291F20DFDB7F436BC246D31AB027A80B3725C631106FDF2A2A
      ```
      Re-read it rather than trusting this copy if the request is filed later:
      `az functionapp show -n demi-api-test -g c4b0a8-test-rg --query customDomainVerificationId -o tsv`
      Then, only after `dig +short CNAME demi-api-test.projects.eao.gov.bc.ca` answers:
      `az functionapp config hostname add` → `az functionapp config ssl create` → `ssl bind --ssl-type SNI`
      (B1 supports custom domains and the free managed cert; `publicNetworkAccess` is Enabled and
      there are no IP restrictions, so validation passes).
      **Acceptance:** `curl -o /dev/null -w '%{http_code}'
      https://demi-api-test.projects.eao.gov.bc.ca/api/config` → 200 on a valid chain, and
      `hostNameSslStates[?name=='…'].sslState` → `SniEnabled`.
      **The cost of the alternative, named once so the lead time is a chosen cost:** a same-origin
      `location ^~ /api/demi/` already exists on rproxy (`eao-nginx/conf.d/server.conf.tmpl:185`,
      currently pointed at eagle-api). It needs no DNS ticket, no CORS and no CSP. The plan rules it
      out because rproxy is *Eagle's* proxy and DEMI is EAO-wide — that is the trade being made.
- [x] **DONE 2026-08-22 (code). Turn `alwaysOn` on for any demi-api serving eagle-public.**
      `alwaysOn: true` is now in `azure/modules/api-web-app.bicep` siteConfig, so it survives the
      next deploy rather than drifting back. **Not yet applied to the running app — that needs a
      deploy.** Checked while there: `azure/modules/extractor.bicep` is a second Function App on
      FC1/FlexConsumption, where alwaysOn is invalid; leaving it alone was correct, not an
      oversight. Currently `false`, and **no bicep
      property sets it** — `grep -rn alwaysOn azure/` returns nothing, so the live value is the ARM
      default. `demi-plan-test` is B1/Basic, which supports it. Without it the host unloads after
      ~20 min idle and the next browser request cold-starts for ~50s with an empty body — which to a
      browser is indistinguishable from a CORS failure.
      Durable fix, one line in `azure/modules/api-web-app.bicep` after `linuxFxVersion` (:155):
      ```bicep
          alwaysOn: true
      ```
      A `az functionapp config set --always-on true` works but drifts back on the next deployment,
      because ARM re-applies siteConfig defaults for properties the template omits.
      **Acceptance:** `alwaysOn` is `true` AND still `true` after the next `main.bicep` deploy.
      **Consequence to handle, not ignore:** see the struck-through 402 latch entry below — alwaysOn
      is precisely the "if the app ever gets long-lived" condition that entry names.
- [ ] **~~Fix the `DemiEventsHourly_CL` schema mismatch.~~ — measured; it is what-if noise, not a
      blocker.** The `deploy-audit-logs` PUT succeeded and the live table is correct. Azure Monitor
      *adds* the summary rule's four `_Bin*`/`_Rule*` columns to the table rather than honouring the
      narrower declared set, and what-if diffs the `columns` array positionally, so 12 live vs 8
      declared renders as `4 Delete + 8 Modify`. Same kind as the documented bogus
      `origins/storage` Modify on eagle-public. Declaring the leading-underscore columns could be
      rejected outright — Azure reserves that namespace. Do nothing; it goes on the baseline-noise
      list in F6.
- [ ] **Search Index Data Reader on `eagle-search-test` — only if demi-api must read the eagle
      indexes during transition. Decide first; it may be dead weight.** `demi-identity-test` already
      holds Search Index Data **Contributor** on `demi-search-test`, and demi-api-test's
      `SEARCH_ENDPOINT` is `demi-search-test`. If F4's rename happens inside `demi-search-test`,
      demi-api never touches `eagle-search-test` and this grant is unnecessary.
      **If it is needed** (objectId `388ed601-3565-4932-a5b8-4d7b543e35a3`, role
      `1407120a-92aa-4202-b7e9-c0e197c71c8f`, dataActions `indexes/documents/read`):
      ```bash
      az role assignment create \
        --role 1407120a-92aa-4202-b7e9-c0e197c71c8f \
        --assignee-object-id 388ed601-3565-4932-a5b8-4d7b543e35a3 \
        --assignee-principal-type ServicePrincipal \
        --scope "/subscriptions/7897ceb1-9a86-4639-87d7-7f9ff67142b3/resourceGroups/c4b0a8-test-rg/providers/Microsoft.Search/searchServices/eagle-search-test"
      ```
      **`--assignee-object-id`, never `--assignee`** — `--assignee` resolves through Microsoft Graph
      and this box's Graph token is expired (`AADSTS70043`); ARM calls still work.
      **A grant here is one-way at this permission level.** `roleAssignments/delete` is denied at
      this RG even though *create* succeeds, and the `permissions` API reporting
      `actions: ['*'], notActions: []` is misleading — the still-open removal of assignment
      `29745ac3` is the standing proof. Verify role id and scope before issuing it.
      **RBAC is not the whole path:** `eagle-search-test` is `publicNetworkAccess: Disabled` with
      `disableLocalAuth: true`; reachability comes from demi-api-test's VNet integration plus
      `WEBSITE_DNS_SERVER` resolving the private endpoint. Both are in place, but a green role
      assignment with a broken privatelink resolve looks identical from the CLI.

### F2. Do not run the naive contract probe — it cannot fail

- [ ] **Read the contract off the code; if a probe is run, give it a discriminator.** Pointing
      demi-api at the `eagle-*` indexes 400s on all three datasets — demi-api selects fields those
      indexes do not have and asks for a semantic configuration that does not exist there — and
      every one of those 400s is caught and turned into a degraded 200. Project and Document search
      would return an arbitrary page of DEMI's own Cosmos rows; DocumentChunk would return an empty
      200. All three read as "contract differences".
      A second, independent reason the chunk leg cannot return rows: `eagle-chunks` carries Eagle
      ObjectIds in `documentId` and demi resolves those against demi's Cosmos, so 100% are withheld.
      The expected output is `[search] withheld chunks whose parent document is not visible` with
      `returned: 0` (`src/controllers/search.js:340`) — **not** evidence of a broken index.
      **Acceptance:** any probe asserts on demi-api's own log lines (`[search] project search
      failed`), never on the HTTP status.

### F3. The seven contract axes — build in demi-api, not eagle-public

eagle-public expects `[{ data: { searchResults: [...], meta: [{ searchResultsTotal }] } }]`
(`src/app/services/search.service.ts:152-167`). demi-api returns `[{ searchResults, count }]`, and
`count` is absent on 13 of its 16 return paths.

**Fix demi-api, not eagle-public** — and the reason is sharper than "avoid a frontend release":
`eagle-public/src/app/services/project.service.ts:49` dereferences `meta[0]` with **no null check**,
inside an rxjs map whose errors are swallowed. An envelope without `meta` does not degrade a count;
it hard-fails the entire projects list and map.

- [ ] **Envelope — and the wrapper is the ANALYTICS TAP, not just a wrapper.** One edit, not
      sixteen: the `res.json` wrapper at `src/controllers/search.js:65-77` already inspects
      `first.searchResults` and `first.count` for metrics. Add `data` alongside the existing
      top-level keys so DEMI's own frontend keeps working unchanged.
      **Returning a different shape from any branch breaks two things silently** — the analytics
      guard at `:73` stops recording that branch, and DEMI's frontend renders an empty column with
      no error, because `apiX[0]?.searchResults || []` swallows it and the catch never fires.
      **`count` is deliberately present on only 3 of the 16 return sites** (`:134`, `:241`, `:381`).
      The comment at `:370-373` is explicit: absent means "not measured", where `0` would be a claim
      about the index. Do not start emitting `count` everywhere — that erases the distinction. Map
      absent-count to an ABSENT `meta`, which eagle-public's `search.service.ts:166-167` accepts as
      total 0 — **except on the projects map path**, where `project.service.ts:49` dereferences
      `meta[0]` unconditionally. Same dataset, two consumers, different strictness.
      **And the unguarded deref does not degrade a count — it navigates the user away.** Corrected
      2026-08-22: `api.ts:74-78` re-throws, so the TypeError propagates through both `catchError`s
      into `projects.component.ts:130-135`, which calls `router.navigate(['/'])`. A malformed `meta`
      on the map path bounces the visitor to the home page.
      `@odata.count` is already requested and returned by all three datasets — that *is*
      `meta[0].searchResultsTotal`, not new work.
- [ ] **`_id`** — implements F0's decision.
- [ ] **Row shape — `project` is HARD-required on Document rows, not merely expected.**
      `search-document-table-rows.component.html:8,10` binds `rowData.project.name` with **no
      optional chaining** — the only unguarded object deref in any row template (every other
      binding uses `?.`). A Document row missing `project` throws on every render of that row.
      demi returns a flat string today. Port `eagle-search/service/shape.js:41-85` — it exists and
      is guarded by `scripts/check-shape.js`.
      Note demi's two adjacent `listByIds` joins behave differently and both are deliberate: the
      chunk join is a **gate** (a parent miss withholds the row, with a warn), while the
      project-name join is **not** (a miss yields `'Associated Project'` and the row still returns,
      silently). Keep that asymmetry.
      **Drop `read[]` from the ported shape** while the field list is being rewritten anyway — see
      the struck-through ACL-array entry below.
- [ ] **Paging — floor `skip` at 0; eagle-public can send `pageNum=-1`.** `ProjectService.getAll`
      defaults `pageNum = 0` (`project.service.ts:33`) and `api.ts:173` sends `pageNum - 1`, so a
      bare `getAll()` emits `&pageNum=-1`. Both live callers pass 1, so it does not fire today —
      but do not trust the value. eagle-search floors it; match that.
      **The map requests `pageSize=1000000`** (`projects.component.ts:118`). Both existing backends
      silently clamp to 1000. Prod has ~358-368 projects, so nobody has noticed; the map is one
      growth spurt from silent truncation.
      `$skip` is never sent and `top` is clamped to 250 at two call sites
      (`src/search/ai-search.js:449`, `:686`); both must change. Design constraints already recorded
      in this file: `$skip` caps at 100,000 and deep skips degrade, and **score-ordered paging is
      unstable across requests**, so a deterministic tiebreak belongs in `$orderby` rather than
      score alone.
- [ ] **Sort — PARTLY UNIMPLEMENTABLE, measured 2026-08-22. Read this before starting it.**
      `orderby` is never set and `sortBy` is never read, but the index definitions cap what can be
      done without a rebuild:
      - **`demi-chunks` marks EVERY field `sortable: false`, the key included.** An `orderby` on the
        chunk index can reference literally nothing. Chunk sort needs an index recreate.
      - **`demi-documents` carries no date field of any kind** — no `dateUploaded`, no `datePosted`,
        no `updatedAt`, not even `_ts` (the datasource selects `c._ts` only as the high-water mark
        and there is no field to land it in). "Sort documents by date" needs an index recreate, a
        datasource change and a full reindex. eagle-search's default document sort is
        `datePosted desc, id asc`, so this is not an edge case.
      - `demi-projects` and `demi-documents` are sortable on everything except `read`.
      **Adding a field is a no-rebuild index update**, so this can ride F4's create-and-refill rather
      than being its own reindex — sequence it there.
      Two live sort quirks on the eagle-public side, both pre-existing:
      `project-notification-documents-table.component.ts:176-180` **inverts** the direction before
      sending (`+` = descending), which is the opposite of every other call site and of
      eagle-search's `query.js:292`; and the same component sends `sortBy=documentAuthor` against
      `dataset=Document`, a field no index has, so that column header does nothing today.
      **Score-ordered paging is unstable across requests** — any relevance sort needs a
      deterministic tiebreak in `$orderby`, or page 2 repeats and omits rows.
- [ ] **Filters — and there are TWO live wire forms, not one.** Measured 2026-08-22: eagle-public
      emits **both** `&project=<id>` (flat, from `fields[]` — certificates, amendments, application,
      featured-documents, project-notifications, the tab probe) **and** `&and[project]=<id>` (from
      `queryModifier` — the documents tab and project activities). eagle-search handles them in two
      different places (`query.js:259-261` and the `query.js:53` alias). Handling only one silently
      returns the unfiltered corpus on the other's call sites.
      **The brackets are NOT percent-encoded on the wire** — `api.ts:202` hands a raw URL string to
      HttpClient with no HttpParams, so Angular does not re-serialize. The parser must handle a
      literal `and[key]` key AND, if Express `extended` qs parsing is on, the nested
      `{and:{key:v}}` object. `eagle-search/service/query.js:114-126` records that getting this
      wrong returned 60,560 documents where a filtered set was expected.
      Port the rest from `eagle-search/service/query.js:219-265`: repeats of a key OR together,
      different keys AND, unknown keys rejected.
      **Also live and harmless-looking: six call sites emit `&fields=[object Object]`** because
      `buildValues` (`api.ts:548-558`) string-concatenates objects. Do not try to parse it; ignore
      the param and make sure ignoring it is deliberate, not accidental.
      **This lands exactly where this file's own fail-open warning points:** OData has no `false`
      literal, so a null or empty filter is UNRESTRICTED, a route that forgets the `empty` flag fails
      **open**, and `test/helpers/access-coverage.test.js` is structural — it would see `filterFor`
      being called and be satisfied. New filter-composition code on every search route is where the
      behavioural suite that entry says "may earn its place later" earns it.
- [ ] **Chunk meta** — `countsPassages` and `documentsOnPage`, which eagle-search emits
      (`service/index.js:419-422`) and demi has no equivalent for.
- [ ] **Reject unknown query params, or implement them.** demi-api reads five and silently drops the
      rest. Page 2 returning page 1, a sort doing nothing, a project filter returning the whole
      corpus — all with a 200 — is the dangerous class here, and it is invisible to a status check.
      **Acceptance for the whole group:** paging to page 2, a sort, and a project filter each
      visibly change the result set in a browser.

### F3a. Defects found reviewing F3 — fix log

The F3 build landed 755/755 with 25 mutation proofs, then an adversarial pass found **eight real
defects the build's own tests could not see**. Recorded because seven of the eight are the same
shape: *the server read the input and then answered something else, with a 200*. A status-code
assertion cannot see any of them, which is why the tests must assert on the emitted request or the
returned total.

- [ ] **S1 (major, security). `term()` gates on `filterable`, not on the field's TYPE.**
      `demi-projects.centroid` is `Edm.GeographyPoint` and filterable, so it passes the gate and
      falls to the quoted-string default — `centroid eq 'x'`, which is not legal on a geography
      field. Azure answers 400, 400 is not in `RETRY_STATUSES`, `request()` throws, and
      `controllers/search.js` logs without returning — so control falls out of the `if (keywords)`
      block into the Cosmos block, **which ignores keywords entirely**. Any anonymous caller can
      make any Project keyword search answer an arbitrary page of the whole readable corpus. Rows
      stay ACL-gated, so it is not a confidentiality bypass; it is exactly the failure
      `eagle-query.js`'s own header exists to prevent.
      Same root cause, second instance: the numeric branch checks that a value PARSES, not that it
      is expressible — `and[pageNumber]=0.5` emits `pageNumber eq 0.5` against an `Edm.Int32`.
      **Gate on "this type has a `term()` case", not on `filterable`.**
- [ ] **C1. `searchDocuments` reports the page length as the total** — it returns
      `Math.max(direct.count, items.length)` and discards leg 2b's index-wide count. eagle-public
      divides that by pageSize to build its pager, so the pager says one page and every later page
      is unreachable. Probed: true total ~503, reported 10.
- [ ] **C2. The keywordless Document path discards the DEMI project id it just resolved** — a
      request scoped to one project returns the whole corpus with a corpus-wide total. The failure
      `resolveProjectFilter`'s own docstring warns about, landing on the *resolvable* branch.
- [ ] **C3. AI-search skip is in the wrong unit** — `pageNum * min(pageSize, 250)` while the client
      pages in units of `pageSize`. Reachable from eagle-public's "Show All" (up to 500):
      `size500 p2` asks for rows 501-1000 and gets `skip=250 top=250`.
- [ ] **C4/C5. A total is synthesised, or asserted, when it is not known.** The Cosmos branches
      compute `count` only when `pageNum` is present, so the wrapper falls back to
      `searchResults.length` — DEMI's own frontend requests `pageSize=500` with no pageNum, so a
      corpus over 500 reports 500. And both Cosmos `catch` branches return `[{searchResults: []}]`,
      which the wrapper turns into `searchResultsTotal: 0` — **a search that FAILED asserting "0
      results" as a fact**, against the wrapper's own documented rule that an absent count means
      "not measured".
      **Constraint on any fix that omits `meta`:** eagle-public's `project.service.ts:49` derefs
      `meta[0]` unguarded and `api.ts:74-78` re-throws, so a missing `meta` on the Project path
      bounces the visitor to the home page. Project answers must always carry a real total.
- [ ] **C6. Cosmos document paging slices a query with no ORDER BY** — `documentsRepo.listVisible`
      passes no `orderBy` (the projects one passes `ORDER BY c.name ASC`), so paging by re-running
      and slicing can repeat and omit rows. Same failure `DEFAULT_ORDER` prevents on the AI path.
- [ ] **C7. The envelope change broke DEMI's own frontend.** `projectId: d.project?._id || …` now
      stores the **Eagle** ObjectId where the bare DEMI project id used to be — the shape changed
      AND the id-space changed, and the patch handled only the shape. Two consumers compare it
      against `Project.id`, still the DEMI/Track id. Note `yarn test` there is `ng test` and needs a
      browser, so it does not run headless — this one is settled by reading both consumers.

### F3b. Introduced by the F3a fixes — and one that eagle-public must absorb

- [ ] **R1 (regression from the C1 fix). `searchDocuments` leg two under-fills the page.** It asks
      the service for only the page DEFICIT, but leg two is deduped against leg one and the two legs
      **overlap by construction** — a document whose own name matches a project-shaped query is
      normally also inside that project — so every deduped row leaves a hole the request was never
      sized to cover. Reproduced: 20 documents in the matching project, 3 also direct matches,
      caller asks `top=10`, page 1 returns **7 rows** under a reported total of 20. Any fix must
      hold at 0%, ~50% and 100% overlap, and must state its request bound.
- [ ] **R2. A WHY comment states a mechanism that does not run.** The justification written for the
      new 502 claims eagle-public re-throws and routes the visitor home. **False for HTTP errors:**
      `api.searchKeywords` returns a bare `http.get` with no `catchError`, and
      `search.service.getSearchResults` swallows every error into `of(null)`. The re-throw path that
      IS real is a different one — a TypeError thrown inside `project.service.getAll`'s own `map`.
      Keep the 502; the comment is what is wrong.
- [ ] **P1/P2 — eagle-public has two unguarded derefs that the 502 reaches.** Both pre-existing;
      the backend change is what makes them fire, so they are a precondition of F5/F5a, not
      optional.
      `project.ts:192` does `res[0].data.searchResults.length` inside a **single-argument**
      `subscribe`; `getSearchResults` turns a non-2xx into a single `null`, not an array, so `res[0]`
      throws with nothing to catch it. And `project.service.ts:49` derefs `meta[0]` unguarded, which
      re-throws all the way to `projects.component.ts:130-135` and `router.navigate(['/'])` — the
      visitor is bounced off /projects. `Utils.extractFromSearchResults` throws one step earlier on
      an empty array, having guarded `!Array.isArray` and then indexed `[0]` anyway.
      **This is the one place the fold touches eagle-public**, so it is also the one frontend
      release the plan otherwise avoids. Two null guards, no redesign.

- [ ] **Known and NOT fixed: leg two's `skip` boundary duplicates a row across pages.** A document
      that matches both the direct leg and the by-project leg can appear on the page where the
      direct hits end and again on the next. Documented in `ai-search.js` rather than fixed — the
      fill fix does not address it and scope was deliberately not widened. Worth closing before the
      soak, because it looks exactly like a paging bug to anyone testing.

- [x] **R1, R2, P1, P2 — DONE 2026-08-22.** R1's fix verified across 16 probe scenarios (0%, ~66%,
      100% overlap; under-, exactly- and over-filled leg one; deep page, last page, past the end,
      the leg boundary, `top=1`, `top=500` with 400 dupes): the page equals the requested `top`
      wherever enough matching documents exist, no duplicate ids on any single page, and the
      request bound is **3-5 HTTP requests**, arithmetic rather than a retry loop. (The fixer's
      report said 4; measured 5 at `top=500` with direct hits.) eagle-demi **784/784**,
      eagle-public **121/121**.
      Four comments that stated false or now-stale mechanisms were corrected: the claim that
      eagle-public re-throws on an HTTP 502 (it does not — `getSearchResults` swallows every error
      into `of(null)`); the wrong throw site for `res = []` (it is `extractFromSearchResults`
      indexing `results[0]`, one step before `meta[0]`); a citation to an unguarded
      `project.service.ts` that the sibling change had just guarded; and the claim that Document
      never answered non-2xx before demi-api — **eagle-search's own `/api/search` has a catch that
      500s**, so that deref was always reachable.
      **And one that would have misled worse than the others:** the `pageSize > 500` refusal was
      justified as "500 is eagle-public's own ceiling, so every live caller fits". Two live callers
      ask for a **million** — `storage.service.ts` and `projects.component.ts` both call
      `getAllFull(1, 1000000)` for the map. They are keywordless, so the `keywords &&` test means
      the guard never sees them; the guard is correct and its stated reason was not.
- [ ] **DECISION NEEDED: an outage and an empty registry look identical to a visitor.** The
      eagle-public guard degrades a failed search to `{totalCount: 0, data: []}`, so
      `projlist-list.component.html` renders **"No projects found"** whether the registry is empty
      or demi-api is down. `search.service.isError` is set but `EventService.getError()` has zero
      subscribers, so nothing surfaces it. The console now carries the error (added this round, and
      proven by mutation), which makes it diagnosable but not visible. Distinguishing the two in the
      UI is a product call, not a defect — decide it before the soak, because during the soak this
      is exactly what a tester will misread.

### F4. Index names — plain, once

- [ ] **Create `projects`, `documents`, `chunks`.** DEMI is EAO-wide, so `eagle-*` and `demi-*` are
      both wrong. **Azure AI Search cannot rename in place** — create and refill. Touches the index
      JSONs in `eagle-search/azure/search/indexes/` (the name is in the filename *and* the body), the
      `SEARCH_INDEX_*` defaults in both services, and the `/ingest/:index` callers —
      `eagle-search/service/index.js:234` routes on the index name and
      `eagle-demi/src/scripts/export-chunks-to-eagle.js:145` hardcodes `/ingest/eagle-chunks`.
      **Every index name recorded elsewhere in this file is a name this deletes.** Do not update them
      one by one; when this lands, sweep once.
- [ ] **Refill in the order the asymmetry dictates.** `projects` and `documents` rebuild from Mongo
      via the existing `worker/full-sync.js`; **`chunks` cannot** — re-running
      `export-chunks-to-eagle.js` is the only path, and it is how the 1.1M prod chunks got there.
- [ ] **Name the writer explicitly.** The Mongo→index worker and a DEMI-side indexer cannot both own
      the same index. Pick one; the answer also decides F9's archive ordering.
- [ ] **Delete the old indexes deliberately, and mind the deletion policy.**
      `dataDeletionDetectionPolicy` is `null` on all three datasources, so a removed row stays
      searchable until `deleteFromIndex` / `deleteChunksForDocument` is called. Two consequences the
      plan missed: (a) create+refill leaves the old indexes serving, so a rolled-back
      `SEARCH_API_PATH` would silently serve a **frozen** corpus; (b) a fresh prod index started from
      a bulk copy retains anything deleted in Eagle between copy start and cutover, forever.
- [ ] **Run any index listing or schema comparison from inside the VNet** — Kudu or the App Service
      itself. All four search services are private-endpoint-only with local auth disabled; the data
      plane is unreachable from a workstation or a CI runner.

### F5a. INTERIM TRANSPORT — same-origin through rproxy, while DNS is pending

**Why this exists.** F1's `.gov.bc.ca` custom domain needs a BC Gov central DNS request and will not
land soon. Same-origin through rproxy needs no DNS, no CORS and no CSP edit, so it unblocks the whole
test proof today. **It is explicitly interim**: rproxy is *Eagle's* proxy, and routing an EAO-wide
service through it is the thing the direct architecture exists to avoid. The nginx block below is
written to be deleted.

**It collapses three blockers, and only these three** — everything else in this section still applies
unchanged:

| Blocked on | Under F5a |
|---|---|
| F1 custom domain + DNS request | not needed for the interim (still file it — F5 is the end state) |
| F5 CORS / `frontendHostNames` | not needed — same origin, no preflight |
| Any CSP edit, either policy | not needed — the call is `'self'` |

**Still required, unchanged: F0 (id-space), F1's missing double-gate, F1's `alwaysOn`, F2, F3, F4.**
F5a is transport only. It changes how the browser reaches demi-api and nothing about what demi-api
answers.

- [x] **DONE 2026-08-22. Add ONE exact-path location to `eao-nginx/conf.d/server.conf.tmpl`.**
      Landed with `${HTTP_BASIC}` on the block, which the first draft below omitted — without it the
      new location is an anonymous internet-reachable proxy onto demi-api in dev and test while
      every page around it sits behind basic auth. Same fix `/lib` got when its block was deleted.
      Prod is unaffected: `httpBasic.enabled: false` there, so the directive expands to nothing.
      **`location ^~ /eagle-search/` has the same gap and was deliberately NOT changed** — it is
      live and something other than a browser may call it; tightening it needs its own change and
      its own verification. Measured today: anonymous `/eagle-search/search` still answers 502,
      i.e. it reaches proxy_pass without auth.
      **Proven, not asserted** — real image, CI's own render, upstream read out of the error log:
      `/demi-search/search?dataset=Document&keywords=a%20b&and%5Bproject%5D=x` reaches
      `http://…:9999/api/search?dataset=Document&keywords=a%20b&and%5Bproject%5D=x` (rewrite right,
      query string preserved, encoding intact); anonymous 401, authenticated 502 from the dead
      upstream; and `/demi-search/projects?pageSize=1000`, `/demi-search/api-docs`,
      `/demi-search/` and `/demi-search/search/` all fall through to `location /` and never reach
      demi-api at all.
      **CI needed two edits or this breaks the build**, both made: `NGINX__EPIC__PROXY__DEMI`
      supplied to the `nginx -t` render (an unset variable is left as a literal and `[emerg]`s at
      parse — reproduced), and `/demi-search/search` added to the auth-gate assertion loop, which
      is the only thing that catches someone deleting that `${HTTP_BASIC}` line later. Model it on the
      `location ^~ /eagle-search/` block directly above — that block's own header already makes this
      case: *"Same-origin sidesteps the CSP, needs no CORS, and keeps the Azure hostname off the
      page."*
      ```nginx
      # demi-api — INTERIM. Delete this block when demi.eao.gov.bc.ca resolves and
      # SEARCH_API_PATH becomes an absolute URL (F5). See TODO.md "The eagle-search fold".
      #
      # EXACT MATCH, NOT A PREFIX. eagle-public calls exactly one URL on this base:
      # `${searchPath}/search?…` (eagle-public/src/app/services/api.ts:198-199; the query string
      # always begins `search?dataset=` at :164). A `^~ /demi-search/` prefix would publish
      # demi-api's ENTIRE route table anonymously on a gov.bc.ca origin — GET /projects and
      # GET /documents accept pageSize up to 1000, plus /documents/:id/download, /boundaries
      # and /api-docs. One route is the whole requirement; publish one route.
      #
      # proxy_ssl_server_name is required — App Service needs SNI and nginx defaults it off.
      # There is no `resolver` in this file, so this hostname resolves ONCE at config load; if the
      # App Service IP moves this location 502s while the name resolves fine everywhere else, and
      # the fix is `oc rollout restart deploy/rproxy`. Both traps are the same ones the
      # /eagle-search/ block documents.
      location = /demi-search/search {
        limit_req zone=api_search burst=20 nodelay;
        proxy_pass ${NGINX__EPIC__PROXY__DEMI}/api/search;
        proxy_ssl_server_name on;
        proxy_pass_request_headers on;
        proxy_connect_timeout 10s;
        proxy_send_timeout    60s;
        proxy_read_timeout    60s;
      }
      ```
      **Acceptance:** `curl -sS -o /dev/null -w '%{http_code}'
      'https://test.projects.eao.gov.bc.ca/demi-search/search?dataset=Project&pageSize=1'` returns
      200 — **and** `/demi-search/projects`, `/demi-search/api-docs` and `/demi-search/` all return
      404 from nginx, proving the exact match holds.
- [x] **DONE 2026-08-22. Wire `NGINX__EPIC__PROXY__DEMI` with the sentinel default.**
      `helm template` per env: dev `http://localhost:9999`, test the demi-api host, prod
      `http://localhost:9999`. All three non-empty, so `proxy_pass ;` is unreachable. `helm lint`
      passes. `values.yaml`, `values-dev.yaml` and `values-prod.yaml` left alone — the sentinel
      covers them. In
      `eao-nginx/helm/rproxy/templates/deployment.yaml`, beside `NGINX__EPIC__PROXY__SEARCH`:
      ```yaml
      - name: NGINX__EPIC__PROXY__DEMI
        value: {{ .Values.nginx.epic.proxy.demi | default "http://localhost:9999" | quote }}
      ```
      **The `default` is load-bearing, not decoration** — envsubst turns an empty value into
      `proxy_pass ;`, which is `[emerg]`, and `conf.d` is included into `http {}`, so it takes the
      **whole proxy** down, not just this route. An unreachable localhost port gives an environment
      with no demi-api a 502 instead of a CrashLoopBackOff. Same reasoning as the SEARCH sentinel.
      Then in `values-test.yaml` under `nginx.epic.proxy`, beside `search:`:
      ```yaml
      # demi-api on Azure, INTERIM. Bare host: the /api/search is added by the proxy_pass.
      demi: "https://demi-api-test.azurewebsites.net"
      ```
      Leave `values-prod.yaml` unset until the prod pass — the sentinel covers it.
- [ ] **Flip the test Mongo `Config` document to `SEARCH_API_PATH: '/demi-search'`** — relative, not
      absolute, for this interim. eagle-public appends `search?…` itself, so the value is the base.
      Read/write commands are in F5; only the value differs.
      Keep the `/eagle-search/` block live in the same release. **Both paths answering in parallel is
      what makes the cutover and its rollback the same one-field Mongo update**, with no redeploy and
      no rollout in either direction.
- [ ] **PARTLY DONE 2026-08-22 — the knob exists; the value has NOT been raised.**
      `RATE_LIMIT_MAX_REQUESTS` now drives the ceiling (`src/middleware/rate-limiter.js`), parsed
      strictly so a blank, fractional or non-positive value falls back to 300 rather than removing
      the limit. It is declared in `azure/modules/api-web-app.bicep` with `param
      rateLimitMaxRequests int = 300` — **that declaration is the point**: appSettings there is a
      whole-collection PUT, so a hand-set value with no template line is deleted by the next infra
      deploy and the ceiling snaps back silently. Never set it by hand.
      **Still to do: raise it in the same change that turns the rproxy path on.** Until then the
      default is right, because the direct path is the only one live.
      Original reasoning, unchanged:
      Measured, not assumed: rproxy sets **no `X-Forwarded-For` header at all** (there is no
      `proxy_set_header` anywhere in `server.conf.tmpl`), and App Service appends
      `<connecting-ip>:<port>` to whatever arrives. demi-api's `callerIp` takes the **last** entry
      (`src/middleware/rate-limiter.js`), which behind rproxy is always rproxy's egress IP.
      **So every visitor shares one 300/min bucket — 5 r/s global — while rproxy admits 10 r/s per
      IP.** One client searching as you type can 429 everyone.
      `MAX_REQUESTS` is a hardcoded const today. Make it env-driven and set it high behind rproxy,
      treating it as a global circuit breaker rather than a per-caller limit; the real per-IP control
      is rproxy's `limit_req zone=api_search`, which keys on `$binary_remote_addr` and is correct.
      Say so in the comment, because the limiter's own header explains a per-caller design that no
      longer describes what it does on this path.
      **Acceptance:** a burst above 300/min through rproxy from two different client IPs does not
      429 either of them.
- [x] **DONE 2026-08-22. Fix the stale rationale before copying it.** Both corrected in the same
      change. The `/eagle-search/` paragraph keeps its conclusion — same-origin is still right for
      the pod-served environments and still needs no CORS — with the reason rewritten and the
      widen-`connect-src` alternative named as the rejected trade, so the rationale is not lost. `server.conf.tmpl:157-160` still says
      eagle-public's CSP *"is baked into that image, so it cannot vary per environment"*. Prod's CSP
      has been a Front Door rules-engine header since v2.7.14. Correct it in the same PR rather than
      letting the new block inherit a false reason by copy-paste. `:59-61`'s claim that the
      `proxy_ssl_*` directives are inert is stale for the same reason and is in the same file.
- [ ] **The exit.** When `demi.eao.gov.bc.ca` resolves: set `SEARCH_API_PATH` to
      `https://demi.eao.gov.bc.ca/api`, do F5's CORS step, delete this nginx block and its values key,
      and revert the rate-limit ceiling. The interim leaves nothing behind in demi-api except the
      env-driven limit, which is worth having anyway.

### F5. Cut test over — cross-origin, no rproxy change  *(END STATE — blocked on F1's DNS)*

- [ ] **Add every eagle-public test origin to `frontendHostNames`.** One array drives **both** CORS
      layers — `azure/modules/api-web-app.bicep:360` builds `CORS_ORIGIN` from it and `:408-411`
      builds the App Service platform allowlist — and **the platform layer answers the preflight
      itself** (`:406`), so setting only one is not enough. Hostnames only, no scheme.
      **There are four eagle-public origins in test, not one.** eagle-public is served by the
      OpenShift pod through rproxy there (`NGINX__EPIC__PROXY__ROOT=http://eagle-public:8080`, unlike
      prod), so the browser origin is the Route host — and there are three Routes. A parallel Azure
      static copy behind `eagle-edge-test` is *also* live and serves the same bundle. All of them
      read the same Mongo `Config` document, so the flip below points every one of them at demi-api
      at once; an origin missing from this list silently 0-results in that browser.
      `azure/main.test.bicepparam:62`:
      ```bicep
      param frontendHostNames = [
        'demi-frontend-test-eaa9cyfydsb0ejet.a02.azurefd.net'
        'eagle-test.apps.silver.devops.gov.bc.ca'
        'test.projects.eao.gov.bc.ca'
        'www.test.projects.eao.gov.bc.ca'
        'eagle-public-test-dbg8ghh8gjd0bscx.a02.azurefd.net'
      ]
      ```
      Deploy through `./scripts/deploy-infra.sh` with all four secrets exported — `appSettings` is a
      whole-collection PUT, so a forgotten export blanks a live credential.
      **Acceptance:** check BOTH layers (`appsettings list --query "[?name=='CORS_ORIGIN']"` and
      `az functionapp cors show`), then a preflight per origin returning
      `access-control-allow-origin` echoing it — **and then load the page and read the console.**
      curl header checks have passed here before while every real call was CORS-blocked.
- [ ] **Flip the test Mongo `Config` document.** There is no script for this in eagle-api — the only
      writer is the one-shot seed migration, which guards itself. It is a direct document update.
      Two corrections to the obvious approach: the Mongo pod has **`mongosh`**, not `mongo`, and the
      credentials are `MONGO_INITDB_ROOT_USERNAME`/`_PASSWORD`/`_DATABASE` with authSource `admin`.
      Single-quote the outer bash so the password expands only inside the pod.
      Read (safe now — currently returns `"SEARCH_API_PATH":"/eagle-search"`):
      ```bash
      oc --context epic-test exec -n 6cdc9e-test deploy/eagle-api-mongodb -- bash -c \
        'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" \
           --authenticationDatabase admin "$MONGO_INITDB_DATABASE" \
           --eval "JSON.stringify(db.epic.findOne({_schemaName:\"Config\"},{SEARCH_API_PATH:1,ENVIRONMENT:1}))"'
      ```
      Write: the same shape with `updateOne(..., {$set:{SEARCH_API_PATH:
      "https://demi-api-test.projects.eao.gov.bc.ca/api"}})`. **Absolute URL, ending `/api`, no
      trailing slash** — eagle-public appends `search?…` to this value verbatim, so a trailing slash
      produces `//search`.
      **Acceptance:** `/api/config` returns the absolute URL and still has 15 keys; the browser's
      Network tab shows `GET https://demi-api-test…/api/search?dataset=Document…` → 200 carrying the
      `data`/`meta` envelope. `/api/config` is served fresh from Mongo per request, but eagle-public
      reads it once at bootstrap — hard-reload.
- [ ] **No rproxy change.** `NGINX__EPIC__PROXY__SEARCH` and the `location ^~ /eagle-search/` block
      (`eao-nginx/conf.d/server.conf.tmpl:179-187`) stay exactly as they are — that is what keeps the
      rollback a one-command revert of a single field.
      **Do not add a `location ^~ /search/` block.** It was the rejected same-origin design and it is
      unsafe besides: `${HTTP_BASIC}` appears only in `location /`, so a new block inherits nothing,
      and a `proxy_pass …/api/` written by analogy with the eagle-search block would publish
      demi-api's **entire route table** anonymously under a gov.bc.ca origin.
- [ ] **Mind the deploy traps this repo already documents:** config propagation lags up to ~3 minutes
      and returns hard errors after ARM reports `Succeeded`; `az functionapp restart` does not recycle
      the Node worker (stop/start does, and even then a warm worker can serve the old build) — poll a
      discriminator.
- [ ] **Soak — but NOT via eagle-public's UI for chunks, because there isn't one.** Measured
      2026-08-22: `DocumentChunk` appears in exactly three places in all of eagle-public's `src/`,
      all plumbing — `api.ts:52` (the AZURE_DATASETS set), a comment in `config.service.ts:13`, and
      `api.search-routing.spec.ts`. No component, template, route or call site ever passes it. So
      "content search is the capability with no fallback" is true of the API and **not** currently
      reachable from the public site; exercise it directly against the endpoint.
      **And expect no error toast when something is wrong.** All four envelope-defect messages go
      through `EventService.setError`, and `EventService.getError()` has **zero subscribers** in the
      whole tree. A malformed envelope shows as an empty table plus a console line. Watch the
      console and the network tab, not the UI.

### F6. IaC — lock in a state that is already clean

**The drift premise does not hold for `c4b0a8-test-rg`.** Measured: 0 declared-but-missing, 0
orphaned, no Create, no Delete. One untracked resource by design (`demi-cicd-test`), one deliberately
gated off (`pe-demi-foundry-test`). The real gap is that **`what-if` cannot see app settings at all** —
`@secure()` masks to `*******` on both sides — which is exactly the class that caused the 2026-08-15
CORS outage. A what-if gate does not cover it; an `az webapp config appsettings list` name-diff does.

- [x] **DONE 2026-08-22. Make `what-if` runnable in CI — on the step, never in the param file.**
      `Validate Test Parameters` added to `pr.yaml`'s `validate-bicep` job. Measured both ways:
      without the env vars `az bicep build-params` exits 1 with four BCP427 errors at lines 26, 27,
      39, 40; with them it exits 0. The bicepparam file was NOT touched. Four params use
      `readEnvironmentVariable` with no default (`azure/main.test.bicepparam:26,27,39,40` —
      `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `ADMIN_API_KEY`, `DOCLING_API_KEY`), so BCP427 fires
      before anything is evaluated. All four are `@secure() param … string` with no `@minLength`, so
      any non-empty placeholder compiles.
      **Do NOT add `''` defaults.** The comment at `main.test.bicepparam:22-25` is the reason, and it
      should be quoted in the PR so nobody "fixes" it in the file: an empty fallback lets a forgotten
      export write an empty credential over the live one, silently, because appSettings is a
      whole-collection PUT and what-if masks secure values on both sides. That is the same mechanism
      as the 2026-08-13 incident above, which destroyed two credentials irrecoverably.
      New step in `.github/workflows/pr.yaml` after `Validate Extractor Module`, matching this repo's
      `env:`-block style:
      ```yaml
      - name: Validate Test Parameters
        env:
          MINIO_ACCESS_KEY: ci-placeholder-not-a-real-key
          MINIO_SECRET_KEY: ci-placeholder-not-a-real-key
          ADMIN_API_KEY: ci-placeholder-not-a-real-key
          DOCLING_API_KEY: ci-placeholder-not-a-real-key
        run: az bicep build-params --file ./azure/main.test.bicepparam --outfile /dev/null
      ```
      Mirrors the working precedent in `eagle-search/.github/workflows/pr.yaml:129-135`. Widen the
      failure summary to name the param file too.
      **Acceptance:** `az bicep build-params …` exits 0 with the env block and 1 without.
- [ ] **Grant `demi-cicd-test` what-if rights at RG scope.** It holds three assignments today, all at
      *resource* scope, so `az deployment group what-if -g c4b0a8-test-rg` fails `AuthorizationFailed`
      before evaluating anything. **No custom role is needed** — `Managed Application Publisher
      Operator` (`b9331d33-8a36-4f8c-b097-4f54124fdb44`) carries `*/read` and
      `Microsoft.Resources/deployments/*` (which covers `whatIf/action` by wildcard) and is **not** on
      the c4b0a8 ABAC deny-list.
      ```bash
      az role assignment create \
        --role b9331d33-8a36-4f8c-b097-4f54124fdb44 \
        --assignee-object-id 39682a03-8b4c-4b05-84c6-b8e06c0a21a4 \
        --assignee-principal-type ServicePrincipal \
        --scope "/subscriptions/7897ceb1-9a86-4639-87d7-7f9ff67142b3/resourceGroups/c4b0a8-test-rg"
      ```
      **CI *apply* stays impossible, and that is correct** — `main.bicep` declares role assignments,
      and no role assignable in this subscription carries `roleAssignments/write` (the four that do
      are all denied). This buys what-if only.
- [ ] **Record the baseline-noise list** so the first CI what-if does not train everyone to skim:
      `demi-cicd-test` untracked by design; `pe-demi-foundry-test` deliberately gated off; ~25
      `Modify` entries that are server-computed properties reported as `before=<value>, after=null`;
      `DemiEventsHourly_CL`'s positional column diff (F1); `summaryLogs/demi-events-hourly
      isActive`, and `isLakeAllowed`/`isTroubleshootingAllowed` on all four `_CL` tables. On
      eagle-public, the `origins/storage` `Modify` is an unresolvable runtime `reference()`.
- [ ] **Settle app registration `acb4198f` before the prod build, not after.** It holds no role
      assignment so it grants nothing today, but it still carries the federated credential
      `github-eagle-demi-main` (subject `repo:digitalspace/eagle-demi:ref:refs/heads/main`) — dormant
      while the app has no permissions, **live the moment it gets any, from a PUBLIC repo**. F7's
      "prod CI cannot apply by design" assumption is exactly what one role assignment on this app
      would break. The decision is already open above; the fold makes it time-sensitive.

### F7. Prod is a greenfield build

- [ ] **BLOCKED on F5 soaking. Stand up the DEMI prod estate.** `rg-demi-prod` holds exactly three
      resources: the search service, its private endpoint, and that PE's NIC. Needed: App Service
      plan, Function App, UAMI, VNet integration, private endpoints, DNS, observability, **and a prod
      Cosmos account**. Cross-references the existing prod-estate entries above rather than restating
      them.
      **Add document storage to that list** — Phase 3b is written and wired behind
      `deployDocumentStorage` (default false) and needs `Storage Blob Delegator` on the identity or
      every download link fails to sign. Not implied by `Storage Blob Data Contributor`.
- [ ] **Copy the corpus into prod Cosmos BEFORE demi-api answers a single prod query.** Cosmos is
      *inside* the search path — chunk results are gated by a Cosmos read of the parent document, so
      with no prod Cosmos every chunk result is withheld and chunk search returns an empty 200.
      That fails **closed**, which is the right direction, and it is why this is a hard prerequisite
      rather than an optimisation. `demi-cosmos-test` is currently the only copy of the extracted
      corpus.
      **Record the row counts once, with their source and date, and cite the query rather than the
      number** — this file's own rule. Two figures already disagree (the search index reports
      1,128,576 chunks; `demi-cosmos-test` is recorded at 1,128,733) and the workspace carries an
      identical unreconciled delta for the prod project/document counts. Reconcile or record both.
- [ ] **The index rename destroys prod's rollback path unless it is coordinated.**
      `eagle-search-api-prod` — the thing answering `/eagle-search` today — reads
      `SEARCH_INDEX_PROJECTS/_DOCUMENTS/_CHUNKS` = `eagle-*` **from `demi-search-prod`**. Renaming
      those renames the indexes the rollback target queries. Either hold both sets through the soak
      (`demi-search-prod` is Basic, 1 partition, 15 GB ceiling; the test-side equivalent measures
      4.08–4.30 GB, so **verify the headroom, do not assume it**) or repoint eagle-search-api-prod's
      three settings in the same change, making it a coordinated two-service cutover. Say which.
- [ ] **`eagle-search-prod` is not a rollback target, and it is not idle.** It holds 39 MB — not the
      1.13M-chunk corpus — and it took 273 queries in the last 7 days. **Identify the caller before
      scheduling its deletion.** "Frozen" is not "idle".
- [ ] **Cost this before committing to it.** A prod App Service plan, a prod Cosmos, prod
      observability, prod private endpoints, and a temporary second copy of all three indexes during
      the rename — none of it is in the plan's numbers, against a budget this file already records as
      over. Re-check the budget figure while you are there: this file says 100 CAD, the workspace
      records 150 CAD RG-scoped.

### F8. Exposure, capacity, observability

- [ ] **Decide the anonymous surface deliberately.** ACL enforcement itself is sound — demi-api gates
      on the same `read[]` field and adds a second gate eagle-search does not have, fail-closed via
      the `empty` flag. But naming the host in a public CSP advertises **nine anonymous GETs**, not
      just search: `GET /projects` and `GET /documents` accept `pageSize` up to 1000
      (`src/controllers/nosql/project.js:36`) — anonymous bulk enumeration of the registry, with
      `read[]`, `eagleId` and `sourceSystem` in each row. Nothing *must* close; it should be a
      decision, not a surprise.
- [ ] **Stop serving `/api-docs` in prod.** It is unauthenticated, documents 6 of 28 routes, and
      advertises an `ApiKeyAuth` scheme it does not enforce. Misleading is one thing on an
      `azurewebsites.net` host and another on a government domain. Cheapest fix consistent with this
      file's own bar is to not serve it in prod — not to write 22 stubs. Note it interacts with the
      dismissed CSP finding above, whose entire justification is "the API serves exactly one HTML
      page, swagger-ui".
- [ ] **Size the rate limit against eagle-public's debounce before the flip.** **Under F5a this is
      not a sizing question but a broken key — see F5a's rate-limit entry, which must be done first.** demi-api's limiter is
      300 requests/60s per caller IP, in-process, single worker. rproxy currently gives 10 r/s
      sustained + burst 20 + 50 concurrent connections per IP. A corporate NAT — a ministry office —
      shares one bucket, and eagle-public searches as you type.
      **And do not "fix" it by putting an edge in front without changing `callerIp`.** The limiter
      keys on the last `X-Forwarded-For` entry; behind Front Door that is the AFD edge IP, so every
      visitor on earth would share one 300/min bucket. That mitigation is a self-inflicted outage
      unless the edge strips spoofed values and the app reads the client entry.
      There is **no WAF anywhere** — zero policies in either subscription, and both AFD profiles are
      `Standard_AzureFrontDoor` (WAF needs Premium).
- [ ] **Replace the search observability that rproxy's access log was providing.** After the flip,
      volume and errors live in demi-api's App Insights and nowhere else. The prod availability
      webtest asserts only that `/` contains `<app-root>`, and the prod CSP has **no `report-uri`** —
      so a CSP or CORS regression is invisible until a user reports it. Add a `report-uri`, or a
      webtest that exercises a real search URL, or accept it explicitly.

### F9. Teardown and archive — last

- [ ] **Re-home three things into eagle-demi before eagle-search's bicep is deleted:**
      `eagle-edge-test` (the only TLS, security-header and SPA-fallback layer in front of DEMI's own
      frontend), the **worker** plus `deploy-prod-worker.yaml` (its only automated deploy *and*
      rollback path), and the **three index definition files**.
- [ ] **Archive cannot happen while the Mongo→index worker is still the writer** — the same decision
      F4 forces. Archiving makes the repo read-only, which removes the worker's deploy and rollback
      path with it.
- [ ] **Delete `is/eagle-search` in `6cdc9e-tools` LAST of all.** Its `prod` tag is what
      `eagle-search-sync` pulls from, so removing it breaks any pod restart while the running pod
      stays up. Remove Helm releases with `helm uninstall`, never by hand-deleting
      `sh.helm.release.v1.*` secrets.
- [ ] **Residue:** orphaned `secret/eagle-search-extract-queue` in `6cdc9e-dev`; test
      `bc/eagle-search` and builds 4–8 with their pods and configmaps. `eagle-search/README.md` still
      claims *"Dark either way: `SEARCH_API_PATH` is empty in prod, so nothing queries the API"* —
      false since the flip.
- [ ] **Preserve `src/scripts/export-chunks-to-eagle.js`.** It is the only tool that can repopulate
      chunks, in any environment.

### F11. Found while specifying F3 — pre-existing, unrelated to the fold

Recorded so they are not rediscovered as "demi-api bugs" during the cutover.

- [ ] **The Cosmos project fallback reads field names the container does not store.**
      `src/merge/project.js:38` writes `projectState` (not `status`) and `:171` writes `eagleId`
      (not `legacyEagleId`). The datasource aliases both for the index, but
      `src/controllers/search.js:178` reads `p.status` and `:175` reads `p.legacyEagleId`. So the
      keywordless default page load returns those fields undefined on the fallback path.
- [ ] **The two project paths disagree on type and on cap.** `trackProjectId` is `String(doc.id)` on
      the AI path (`:108`) and the stored Number on the Cosmos path (`:174`). The frontend asks
      `pageSize=500`; the keywordless list honours it (capped 1000) while a keyword search caps at
      250 — so typing one character can shrink the result set. A junk `pageSize` diverges the same
      way: `parseInt('abc')` is NaN, so the AI path falls to 20 and the Cosmos path to 1000.
- [ ] **`src/swagger/swagger.yaml:7-27` is stale — do not treat it as the contract.** It documents
      `/api/search` with a REQUIRED `q` and a `project` filter param. The controller reads neither
      as described: `q` is optional, and `project` is not read at all. `dataset`, `pageSize`,
      `fuzzy` and `includeSeeded` are undocumented.
- [ ] **Document search issues up to THREE Azure requests per call**, and leg 2b is a `matchAll`
      `search: '*'`. Any per-request budget, rate limit or latency assumption built on "one search =
      one request" is wrong for that dataset.
- [ ] **`GET /api/search/summary` has no parent-document gate** — it hydrates chunks straight
      through `chunksRepo.getById`, unlike `dataset=DocumentChunk`. Safe **only** because
      `routes/api.js:54` mounts it on `authMiddleware`. Opening that route to anonymous callers
      would be a disclosure change, not a routing change.
- [ ] **A service key for the fold must NOT carry a `SECURE_ROLES` role.** `demi-service-read` is in
      `SECURE_ROLES` (`access-sql.js:30`), and `isPrivileged` short-circuits `readClause` to `true`
      — a privileged machine consumer sees every unpublished project's documents. This is what makes
      F1's "mint the scoped service key" load-bearing rather than a nicety.
- [ ] **Batching guidance disagrees with itself.** `.claude/skills/eagle-cosmosdb/SKILL.md:75` says
      50 items for chunk bulk writes; `src/db/cosmos-nosql.js:291` splits at
      `BULK_MAX_OPERATIONS = 100` (the Cosmos hard limit) and `bulkVerified` already retries the
      429s the 50 is meant to avoid. Follow the code, expose a `--batch` to drop to 50 when
      `statusCounts['429']` is large, and never raise it above 100.
- [ ] **`azure/search/README.md:56-59` needs a one-line correction.** It names `retrievable` and the
      semantic configuration as the only exceptions to Azure's drop-and-rebuild rule. That sentence
      is about MODIFYING an existing field; **adding** a new field is separately a no-rebuild
      update. Worth fixing before someone concludes the sort work needs a reindex it does not.
- [ ] **eagle-public pre-existing, cannot be fixed from demi-api, will look like demi-api bugs:**
      `keywords` is interpolated raw into the query string (`api.ts:171`) and never encoded, so a
      `#` truncates the query at the fragment marker and a `&` injects a parameter; and
      `projlist-list.component.html:91` links to `['/a', item._id]`, a route that does not exist, so
      the project side-list's arrow button redirects to the home page.

### F10. Independent of the fold — do these regardless

- [x] **DONE 2026-08-22 (chart). Stop the pointless `eagle-search-sync` restarts in `6cdc9e-test`.**
      `sync.livenessProbe.enabled: false` in `eagle-search/helm/eagle-search/values-test.yaml`.
      Rendered both ways: test renders the sync Deployment with NO livenessProbe, prod still has
      one. **Not yet deployed** — needs `helm upgrade` against `6cdc9e-test`, and the acceptance
      below only counts after a quiet period longer than 6h15m.
      Trap confirmed at render time, not just by reading: `eagle-search.env` emits exactly 8
      variables (6 Mongo, INGEST_URL, INGEST_KEY) plus 2 conditional EXTRACT_* that are off in both
      environments — `SYNC_MAX_TOKEN_AGE_SECONDS` is not among them, so setting it in values would
      have been inert. 65 restarts in 32h, exit
      137 (SIGKILL, not OOM). **Not a crashloop** — the worker is healthy (`Connected to MongoDB /
      Lookups loaded / Resuming change stream`) and is being killed by its own liveness probe:
      `Liveness probe failed: last applied change 21786s ago, limit 21600s — change stream looks
      wedged`. There is no readiness probe, so it reports 1/1 Ready throughout. The 6h default was
      calibrated on **production** cadence (~20-60s between applied events,
      `worker/healthcheck.js:11-15`); prod has 0 restarts in 44h, so the threshold is right there and
      wrong in a quiet test.
      **Plan correction: `SYNC_MAX_TOKEN_AGE_SECONDS` in `values-test.yaml` would be inert.** The env
      block is `{{- include "eagle-search.env" . }}` and that helper emits exactly nine vars, none of
      them this one — setting it in values changes nothing without a `_helpers.tpl` edit. The real
      one-line fix, in `eagle-search/helm/eagle-search/values-test.yaml` under `sync:`:
      ```yaml
        livenessProbe:
          enabled: false
      ```
      `sync.livenessProbe.enabled` is already the gate in `sync-deployment.yaml:36`, so this needs no
      template change. A probe whose only job is spotting a wedged stream, in an environment with no
      stream traffic to wedge, has nothing to detect.
      **Acceptance:** the probe is gone from the spec, restart count stays 0 across a full quiet
      period (**longer than 6h15m** — the observed kill interval), and no new `Unhealthy` events.
- [ ] **Rotate `INGEST_KEY` on `eagle-search-api-test` AND `-prod`.** Both were printed into a session
      transcript. **Both app services already carry `INGEST_KEY` and `INGEST_KEY_NEXT`**, and
      `eagle-search/service/helpers/api-key.js:37-38` accepts either during the roll (both branches
      always evaluate; `sameSecret` hashes then `timingSafeEqual`; an unset variable fails closed).
      **The previously written recipe was wrong on both halves:** `az search admin-key renew` cannot
      rotate anything — both services have `disableLocalAuth: true`, so admin keys do not exist — and
      `INGEST_KEY` is not a search key at all, it is an app-setting shared secret checked by
      eagle-search's own `requireKey`.
      Callers, all verified live: `deploy/eagle-search-sync` and `cronjob/eagle-search-reindex` in
      `6cdc9e-test` and `deploy/eagle-search-sync` in `6cdc9e-prod`, all via secret
      `eagle-search-ingest` key `INGEST_KEY`; and `src/scripts/export-chunks-to-eagle.js:147`, which
      takes it as a `--key` CLI arg (hand-run, nothing to redeploy).
      Order: arm `INGEST_KEY_NEXT` on both app services → move every caller → promote to `INGEST_KEY`
      and clear `NEXT`. Generate into a variable and never echo it.
      **The trap that would silently undo it:** `main.searchprod.bicepparam` reads `INGEST_KEY` from
      `readEnvironmentVariable('EAGLE_SEARCH_INGEST_KEY')`, so the next infra deploy writes whatever
      is exported at that moment over the live value. The operator's export must be the new key.
      **Acceptance:** the App Service value's digest matches the OpenShift secret's, per environment,
      and the OLD key returns 401 against `/api/ingest/…`.
      Durable fix: a Key Vault reference, so a read-only inventory cannot return the value at all.
- [ ] **Rotate `RPROXY_EGUIDE_PASSWORD`** — also leaked. **Different mechanism entirely** (rproxy
      basic auth, OpenShift-only, no App Service side, no dual-key slot). Do not fold it into the
      `INGEST_KEY` sequence.

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
      feature is actually for, and no label set covers them; ~~there is no query log to build one from
      because nobody uses DEMI yet~~ — the fold puts real public queries through this API, so build
      the label set from the first month of logs. Depends on the observability entry: nothing is
      retained today. The gain above is a floor, not an estimate.

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
      trips worst case. ~~Bounded and measured, not a bug — but it is the first thing to look at if
      search latency becomes a complaint.~~ — the fold puts public debounced keystrokes on this
      path; capacity is a precondition now, not a watch item. See F8.
- [ ] **The ACL array is returned to anonymous callers**, so the role taxonomy is public. Disclosure,
      not bypass; ~~it disappears with the projection above~~ — that projection is deferred, and the fold moves this to the public internet on a `.gov.bc.ca` origin. Drop `read[]` in the fold's ported row shape instead (F3), which is where the field list is being rewritten anyway.

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
      rather than conventional. ~~Not changed here because highlighting also reads that field and the
      interaction cannot be tested from outside the VNet.~~ — **superseded.** It had to flip to
      `true`: semantic configuration fields must be searchable *and* retrievable. See "`content` is
      `retrievable: true` and the index no longer stops whole chunks leaving" under Semantic ranker,
      which is the current state. Flipping it back now would break the ranker. F3's row-shape work
      will make someone read all of these — this one is closed.
- [ ] **Deletes are permanently the application's job.** `dataDeletionDetectionPolicy` is `null` on
      all three datasources, so a removed row stays searchable until `deleteFromIndex` /
      `deleteChunksForDocument` is called. Already wired into `deleteProject`/`deleteDocument`; the
      obligation never goes away, and it is invisible in the indexer config.
- [ ] **No index-level paging.** `$skip` is never sent and `top` is clamped to 250 at two call sites
      (`src/search/ai-search.js:449`, `:686`). ~~a result set past the first page is unreachable
      rather than slow~~ — this is now the PAGING axis of the fold; see F3. Both call sites change.
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
      **The fold does NOT settle this, and is the entry most likely to be wrongly marked resolved by
      it.** eagle-public reaches search at `/api/search?dataset=Project`, not at `GET /projects`. If
      F3's row-shape port does not call this endpoint, the decision is unchanged — record that
      explicitly rather than leaving it ambiguous. What the fold *does* change is the exposure: F8
      records that `GET /projects` accepts `pageSize` up to 1000 anonymously, and after the fold that
      is on a `.gov.bc.ca` origin.
- [ ] **Drop the dead `logs` and `leases` containers?** Nothing reads or writes either; `leases` has
      no indexing policy so Cosmos indexes every path it is given. Removing them from the Bicep does
      NOT delete them — that is a hand-run `az cosmosdb sql container delete`, and the template
      change alone would only create drift.

### 3. Hardening — real, none urgent

- [ ] ~~**`content: retrievable: false` on `demi-chunks`.**~~ — **closed, superseded.** The field had
      to flip to `true` for the semantic ranker; see that entry under Semantic ranker for the current
      state and the CI assertion that guards `select`. Do not flip it back.
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
      rollover keeps serving BM25 until it restarts. ~~Fine today — App Service recycles well inside a
      month~~ — **F1 turns `alwaysOn` on, which is exactly the "if the app ever gets long-lived"
      condition this entry names.** One 402 then degrades public search to BM25 indefinitely. The
      trade was deliberate while the worker recycled; it is not any more. Restart after a 402, or
      reset the latch at rollover.

## Search UI

- [ ] **Result paging — REQUIRED by the fold (F3).** `searchChunks` sends only `top` (default 20,
      hard cap 250) and never sends `$skip`; the controller has no offset and the frontend has no
      load-more. ~~Left alone deliberately — nobody uses DEMI yet, and this is a decision for whoever
      owns the search UI.~~ — eagle-public is now the named consumer and it pages. The constraints
      below survive as design input rather than as reasons to defer: `$skip` caps at 100,000 and deep skips degrade, and score-ordered paging is
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
- **The rate limit is real now, so callers behind one NAT share a 300/minute bucket (#73).** ~~Nobody
  has measured that under load.~~ — the fold makes a NAT-shared bucket a public-outage shape (a
  ministry office, searching as you type). Size it against eagle-public's debounce before the flip;
  see F8. The mechanism stays proven and the `draft-7` re-verification below stays dismissed — it is
  the ceiling that is unmeasured, not the limiter.
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

**The eagle-search fold is the one deliberate exception to that scope line.** It reaches into
`eagle-search`, `eagle-public` and `eao-nginx`, and into `6cdc9e-test`/`6cdc9e-prod`, because DEMI is
taking over a capability those systems own today. That is a named coupling, not scope creep — and it
ends when eagle-search is archived.
