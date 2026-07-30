# DEMI → Cosmos DB for NoSQL — live migration status

> **Living document.** Updated as each phase lands. If a session is lost, start here.
> Full design rationale: wiki `ADR-004-Read-ACL-Authorization-Model` and
> `Environment-Reality-and-Operational-Gotchas`.

**Last updated:** 2026-07-30 · **Current phase:** 2 (data access + authorization) — foundation landed

---

## Goal

DEMI becomes the EAO's central store for **Projects** and **Documents**, holding a *merged*
model across `epic.track` (authoritative for projects), `eagle` (richer EA-process data),
NRPTI (external compliance data) and eventually `epic.submit`.

Simultaneously, move off Cosmos DB's **MongoDB API** to its **NoSQL API** with
`@azure/cosmos`. `DEMI_PLAN.md` claimed for months this had already happened; it had not, and
the half-finished attempt produced the SQL-string-over-mongo-driver shim whose dropped
predicates disabled all access control (ADR-004).

**Build clean and re-seed from source — do not migrate the data.** Everything is reproducible
from upstream, and the current database carries Mongoose legacy, 3,382 synthetic project rows,
and `contentExtracted: true` flags with no chunks behind them.

---

## Phase status

| Phase | State | Notes |
|---|---|---|
| **0 — Delete unreachable code** | ✅ done (`99889e6`) | −1,536 lines; 5 latent bugs fixed; lint 0 errors |
| **1 — Infrastructure (templates)** | ✅ written, ⏸ **not deployed** (`d8438a2`) | Deployment deferred on cost — see below |
| **2 — Data access + authorization** | ✅ done (`09b35f1`, `d6de8a6`, `cc08ba8`) | Client, repositories, controllers, router switch |
| **2b — Delete semantics** | ✅ done (`7f5e4a8`) | Hard delete + index removal; unpublish is the hide mechanism |
| **2c — Object key + switch fixes** | ✅ done (`cc8a6b7`) | Downloads verified end to end; switch is now an explicit flag |
| **3 — Merge engine** | ✅ done | `src/merge/project.js` + 41 tests on the real 382-record Track dataset. Project scope now derived from Keycloak roles |
| **3b — Blob storage** | ✅ code + template written, ⏸ **not deployed, nothing copied** | `src/storage/` abstraction live on both backends; Bicep validated; copy script dry-run only |
| **4 — Seed** | ✅ code written, dry run passes; ⏸ **nothing written** (no account) | `src/seed/` + `seed-nosql.js`; gates pass on live sources |
| **5 — Cut over** | 🔶 **IN PROGRESS — infra deployed, cutover NOT done** | Account + identity live; code deploy blocked on Oryx. **Resume steps below.** |
| **6 — Typesense** | ✅ code written, ⏸ **no reindex run** (no account) | `transform-nosql.js` + `full-sync-nosql.js` behind the same `USE_COSMOS_NOSQL` flag |
| **7 — Change feed** | ⬜ deferred | Functions trigger + `leases`. No soft-delete marker needed — index removal is explicit |
| **8 — Decommission** | ⬜ todo | Delete the Mongo account after a clean week |

### Open decisions blocking nothing yet

- ~~**Where project membership comes from**~~ **Closed 2026-07-30: Keycloak, via role names.**
  Keycloak dictates all roles, so there is no separate membership store. Scope arrives as roles
  prefixed `project:` — `project:207` scopes the caller to project 207. The prefix is required
  because a bare role name cannot be classified: given `ajax`, nothing distinguishes "scoped to
  the Ajax project" from a role type like `staff`, and guessing would be a security bug either
  way. `project:*` roles are stripped from the `read[]` role list so the two dimensions never
  mix. The value is a canonical project id, keeping `resolveAccess` synchronous and lookup-free.
  Accepting a project *name* would need a cached slug→id map — noted, not built.
- **Whether to move prod document storage to Azure.** Dev only is planned. The safety argument
  is weaker than first stated — environments already use separate buckets
  (dev `asnpnn`, test `zdspnb`, prod `ozwdez`).

### 🔶 Phase 5 IN PROGRESS — exact state as of 2026-07-30

**The running app is unchanged.** No restart has happened, so dev behaves exactly as before.

| Thing | State |
|---|---|
| `demi-identity-dev` (UAMI) | ✅ created — `principalId c2de07f1-f908-418b-8042-af36519d26d7`, `clientId a2c6d746-1277-4b7a-b9e8-892b40c9e9c9` |
| UAMI attached to `demi-api-dev` | ✅ — it had **no identity at all** before; `identity.bicep` only creates it, the assignment is a separate step |
| `demi-cosmos-dev` | ✅ NoSQL, 10 containers, `disableLocalAuth`, public access disabled |
| `pe-cosmos-nosql-dev` | ✅ created, IPs `10.46.51.8` / `10.46.51.9` |
| **Private DNS zone group** | ⏳ **NOT yet attached** — the DINE policy runs on a delay. Must exist before the app can resolve Cosmos |
| App settings | ✅ `COSMOS_ENDPOINT` repointed, `COSMOS_DATABASE=demi`, `AZURE_CLIENT_ID` set, **`COSMOS_KEY` deleted** |
| `USE_COSMOS_NOSQL` | **`false` — deliberately** |
| Code deploy | ❌ **failed**, see below |
| Seed | ⬜ not run — Cosmos is empty |

**Why the flag is `false`:** it was set to `true`, but the app has not restarted, so it never took
effect. Left `true`, any platform-initiated restart would have brought dev up against an **empty**
database. It goes back to `true` only once the code is deployed and the seed has run.

#### The deploy failure is environmental, not our code

Oryx ran `yarn install` on the app service and could not reach `registry.yarnpkg.com`
(`ESOCKETTIMEDOUT` after 10 retries). Outbound is forced through the VNet by
`WEBSITE_VNET_ROUTE_ALL=1`, and that path has no route to the public registry.

The build is both redundant and the thing breaking us — the zip already ships `node_modules`
(14,860 files; `saslprep/dist` verified intact, i.e. the packaging trap is not reintroduced).
`SCM_DO_BUILD_DURING_DEPLOYMENT` is already `false`; **`ENABLE_ORYX_BUILD` is still `true` and must
be set to `false`.**

#### Resume steps, in order

```bash
RG=c4b0a8-dev-rg

# 1. stop Oryx trying to build inside the VNet
az webapp config appsettings set -g $RG -n demi-api-dev --settings ENABLE_ORYX_BUILD=false

# 2. package and deploy (node_modules ships in the zip)
python3 scripts/package-api.py . /tmp/api-deploy.zip
az webapp deploy -g $RG -n demi-api-dev --src-path /tmp/api-deploy.zip --type zip
#    A 504 from the CLI is only its poller giving up — check the real status at
#    /api/deployments/latest. Kudu status: 3 = FAILED, 4 = SUCCESS. `complete: true` alone
#    does NOT mean success.

# 3. confirm policy attached DNS (must be non-empty before seeding)
az network private-endpoint dns-zone-group list -g $RG --endpoint-name pe-cosmos-nosql-dev

# 4. seed INSIDE the network via Kudu, detached with a log — /api/command is synchronous
#    and will time out on 60k documents
#    node src/scripts/seed-nosql.js --live --only projects,documents,boundaries

# 5. cut over
az webapp config appsettings set -g $RG -n demi-api-dev --settings USE_COSMOS_NOSQL=true
az functionapp stop  -g $RG -n demi-api-dev && az functionapp start -g $RG -n demi-api-dev
#    stop THEN start — `restart` does not recycle the Node worker

# 6. verify, then run the Typesense reindex (npm run typesense:sync-nosql)
```

**Rollback at any point:** `USE_COSMOS_NOSQL=false` + stop/start. `MONGODB_URI` is untouched and
both data layers coexist until Phase 8, so nothing is one-way yet.

### Phase 5 pre-flight (done 2026-07-30) — 4 blockers found and fixed

All three modules now return `status: Succeeded, error: None` from
`az deployment group what-if` against the **live** `c4b0a8-dev-rg`:

| Module | Creates |
|---|---|
| `identity.bicep` | `demi-identity-dev` (1 resource) |
| `cosmos-nosql.bicep` | account + `demi` database + **10 containers** + 1 `sqlRoleAssignment` + PE |
| `document-storage.bicep` | account + blobService + `documents-dev` container + 2 role assignments + PE |

**Blocker 1 — private DNS would have failed the deployment.** `document-storage.bicep` created its
own private DNS zone, VNet link and zone group. The deployed environment says otherwise: the
existing `demi-mongo-pe` carries a zone group named **`deployedByPolicy`** whose zone lives in a
*different subscription* (`bcgov-managed-lz-live-dns`). BC Gov's managed landing zone attaches
private DNS by Azure Policy. Our own version would have (a) failed on `virtualNetworkLinks`, since
the VNet is in `c4b0a8-dev-networking` which this identity cannot even list, (b) created a second
zone competing with the platform's, and (c) been redundant, because policy adds its own group to
every new endpoint. **Now creates the endpoint only and lets policy wire DNS.** `cosmos-nosql.bicep`
was already correct.

**Blocker 2 — `dataset` vs `nrptiSchemaName`.** The seed writes `dataset` (from NRPTI's
`_schemaName`); `records.buildCriteria` filtered `nrptiSchemaName`, which is the **Typesense** field
name. No Cosmos item has that property, so `GET /api/records?dataset=Inspection` matched nothing —
and the Bicep indexed the same wrong path, so the field actually filtered on stayed unindexed and
scanned. Both fixed.

**Blocker 3 — the network is not what `azure/main.bicep` describes.** There is **no VNet in the
resource group**; `azure/modules/vnet.bicep` was never deployed. The real subnet is the platform
vWAN spoke:

```
/subscriptions/…/resourceGroups/c4b0a8-dev-networking/providers/Microsoft.Network/
  virtualNetworks/c4b0a8-dev-vwan-spoke/subnets/c4b0a8-dev-cond-ext-pe-subnet
```

Pass that as `peSubnetId`. Do not deploy `main.bicep` expecting it to build networking.

**Blocker 4 — `COSMOS_ENDPOINT` is already set, pointing at the Mongo account**, and `COSMOS_KEY`
exists. The new account has `disableLocalAuth: true`, so there is no key. These must be
**repointed and deleted**, not merely added to — this is the same stale-config trap that made
`Boolean(process.env.COSMOS_ENDPOINT)` silently activate the wrong data layer.

#### App settings delta on `demi-api-dev`

| Setting | Action |
|---|---|
| `COSMOS_ENDPOINT` | **repoint** to `https://demi-cosmos-dev.documents.azure.com:443/` |
| `COSMOS_KEY` | **delete** — no key exists on the new account |
| `AZURE_CLIENT_ID` | **add** — the UAMI client id, selects the identity |
| `USE_COSMOS_NOSQL` | **add** `true` — the only switch that activates the new layer |
| `COSMOS_DATABASE` | already `demi`, verify |
| `STORAGE_BACKEND` | leave unset (defaults to `minio`) — blobs are not copied yet |
| `MINIO_*` | **keep** — still the live object store |
| `MONGODB_URI`, `MONGODB_DATABASE` | **keep until Phase 8** — the rollback path |
| `WEBSITE_VNET_ROUTE_ALL`, `WEBSITE_DNS_SERVER` | already set; required for private-endpoint DNS |

**Rollback is one setting:** `USE_COSMOS_NOSQL=false` plus `stop`/`start`. Both data layers coexist
by design until Phase 8, so nothing is one-way until the Mongo account is deleted.

Also verified: the deploy package includes `src/seed/`, `src/merge/`, `src/storage/`,
`src/typesense/*-nosql.js` and `seed-nosql.js` (`package-api.py` prunes only at the repo root), so
the seed can run inside the network via Kudu. **No user-assigned identity exists yet**, so
`identity.bicep` must deploy first — its `principalId` feeds the other two modules.

### Why Phase 1 is written but not deployed

Serverless Cosmos is effectively free when idle (storage only, ~76 MB), but its **private
endpoint is a flat ~$7/month regardless of use**. Two accounts in parallel pays it twice for
the whole overlap. Every test here mocks the repositories, so no live account is needed to
build and verify Phases 2–3. Provision → seed → cut over → decommission happens in one
window, making the overlap hours instead of weeks.

**Nothing billable has been created.** Dev RG still has its original 15 resources.

### Phase 2 progress

**Landed** (new files, built alongside the old layer so the app keeps running on Mongo):

| File | What |
|---|---|
| `src/helpers/access-sql.js` | `resolveAccess` (3 tiers), `readClause`, `scopeClause`, `andClauses`, `visibilityFor`, `canRead` |
| `src/db/cosmos-nosql.js` | `query`/`queryValue`/`readItem`/`create`/`upsert`/`replace`/`patch`/`remove`/`bulk`/`ping`, all fail-closed |
| `src/repositories/_sql.js` | `eq`/`contains`/`selectWhere`/`countWhere`/`pageOptions` — visibility is always ANDed in, never optional |
| `src/repositories/{projects,documents,records,boundaries,fragments}.js` | Named methods, each owning its SQL |
| `test/helpers/access-sql.test.js` | Asserts **emitted SQL and params** per tier |
| `test/db/cosmos-nosql.test.js` | Pins that a non-spec input **throws** rather than degrading |
| `test/repositories/repositories.test.js` | Asserts the SQL each repository emits |

| `src/controllers/nosql/{project,document,record,boundary}.js` | Thin HTTP layer over the repositories |
| `test/controllers/nosql-controllers.test.js` | Tier resolution, partition-key protection, parent-ACL rule, route parity |

`@azure/identity` added (the one new dependency). Tests **166/166**, lint 0 errors.

### 🔑 The cutover switch

`src/routes/api.js` picks the controller set from **one** conditional:

```js
const USE_NOSQL = Boolean(process.env.COSMOS_ENDPOINT);
```

Unset today, so dev still runs on Mongo and is unaffected. **Setting `COSMOS_ENDPOINT` flips
every route at once** — that is the whole of Phase 5's code change.

The two controller sets are deliberately **not** abstracted behind a common interface: they
take fundamentally different inputs (Mongo filter objects vs an access context), and an
adapter over both is precisely the shape that let a half-working translator disable access
control here before. A test asserts both paths expose the identical route surface, so the
switch cannot silently add or drop an endpoint.

**Remaining for cutover:** delete `src/models/*.js`, `src/db/cosmos.js`,
`src/helpers/access.js`, the legacy controllers, the `USE_NOSQL` branch, and `mongodb`.

Controller notes:
- A hidden project returns **404, not 403** — a 403 would confirm the id exists.
- Update paths refuse to reassign a partition key (`id` on projects, `projectId` on documents,
  `type` on boundaries): in Cosmos that is a delete-and-reinsert, not an update.
- `resolveDocumentAcl()` is used by **both** document write paths. The Mongo version had it in
  `createDocument` only, so an intake upload could be published under a private project.
- `deleteDocument` is a **soft delete**. The change feed emits no deletes in latest-version
  mode, so a hard delete would strand the document in Typesense forever.
- `getProjectFragments` is the read path for independently-ACL'd fragments; a caller lacking
  the roles gets fewer items, never a stripped object.

Repository design notes:
- **No generic `find(filter)`.** A filter-object interface is what let a broken translator
  disable access control. Each method owns its SQL and cannot emit an unfiltered read.
- **`countWhere` shares `selectWhere`**, so a count can never drift from its list predicate —
  a count built from a different filter leaks the size of a set the caller cannot read.
- **`boundaries` deliberately has no ACL predicate.** It is public reference data with no
  `read[]`; applying the standard clause would match nothing and blank the map. Stated in the
  file so it reads as a decision, not an omission.
- **`fragments.put()` refuses an empty `read[]`.** A fragment with no ACL would fall back to
  the `isPublished` mirror and could become publicly readable — the opposite of the point.
- Paging uses **continuation tokens**, not skip/take: Cosmos has no efficient offset, so page
  N would cost as much as pages 1..N combined.
### Deletion semantics (decided 2026-07-30 — supersedes the earlier soft delete)

| Action | What it does |
|---|---|
| **Unpublish** (`PUT /documents/:id/published`) | Hides from public and proponents: `isPublished: false` and `read[]` loses `public`. **This is the hide mechanism.** |
| **Hard delete** (`DELETE /documents/:id`) | Permanently removes the Cosmos item **and** the Typesense entry. |
| **The stored blob** | **Never deleted by any request path.** Orphans are reclaimed by a separate audited job. |

The index entry is removed **explicitly** rather than via the change feed (which emits no
deletes in latest-version mode) — doing it directly is what makes a soft-delete marker
unnecessary at all, removing that whole class of confusion.

Index removal is **best-effort**: the record is already gone from Cosmos and the nightly full
sync reconciles via alias swap, so a Typesense failure must not turn a successful delete into
a 500. The response reports `removedFromIndex` and `storedFileRetained` so the outcome is
explicit rather than implied.

Publishing a document under an **unpublished project returns 409** — a document may never
out-rank its parent.

### Object storage (Phase 3b — code written, nothing deployed or copied)

`src/storage/` is the single entry point. **Four operations**, because that is all the
application does with stored files:

```
getBuffer(key)                  -> Buffer            (extraction)
getDownloadUrl(key, opts)       -> short-lived URL   (download endpoint)
putFile(key, filePath, ctype)   -> stored key        (upload)
describe()                      -> non-secret info   (logs, health)
```

No bucket, container, or client escapes the module. Backend is chosen by an **explicit**
`STORAGE_BACKEND` (`minio` | `azure`); an unknown value **throws at load**. Not inferred from
whichever credentials are present — that is how `COSMOS_ENDPOINT` silently activated the wrong
data layer on deploy.

**A real bug this fixed.** `extract.js` read `doc.s3Key` **raw**, with no environment key
prefix, so every extraction in dev fetched a key that 404s — the identical bug the download
endpoint already had and had fixed at its own call site. Meanwhile both HTTP controllers were
importing the *batch extraction script* purely to borrow its MinIO client. One cause: no single
owner of the storage path. The prefix now lives inside the MinIO backend, where no caller can
forget it.

Verified end to end against real dev storage after the rewire: `etl/29694-marshall-road-…pdf`
→ **638,034 bytes, `application/pdf`, `%PDF-1.4`**, byte-identical via `getDownloadUrl` and
`getBuffer`. The `getBuffer` path is the one that was previously broken.

| | MinIO | Azure Blob |
|---|---|---|
| Auth | access key + secret | **Entra managed identity, no keys** (`allowSharedKeyAccess: false`) |
| Environment isolation | one bucket, nested `ozwdez/` prefix | **one container per environment** |
| Download URL | presigned GET | **user delegation SAS**, `sp=r`, https-only |
| Container creation | on demand | **never** — comes from Bicep |

Per-environment containers are the actual safety win. Dev's `MINIO_HOST` is one env-var edit
from prod storage today; a container reachable only by that environment's identity makes the
mistake impossible rather than discouraged. That also removes the need for a key prefix, so the
recorded `s3Key` becomes the blob name verbatim.

**Three gotchas worth not rediscovering:**

- **`Storage Blob Delegator` is required** and is *not* implied by `Storage Blob Data
  Contributor`. Without it `getUserDelegationKey` fails, and with shared-key access disabled a
  user delegation SAS is the only way to sign a download link — so every download breaks.
- **The delegation key's `signedStartsOn`/`signedExpiresOn` must be `Date` objects.** The
  generated mapper types them as `String`, but `generateBlobSASQueryParameters` calls
  `toISOString()` on them. `BlobServiceClient.getUserDelegationKey` bridges the two internally,
  so only hand-built keys hit this.
- **The delegation key is cached for 30 min** (valid up to 7 days). Uncached, every download
  adds a round trip; cached too long, it silently produces SAS URLs that fail authentication.

`azure/modules/document-storage.bicep` — validated (`az bicep build`, exit 0), **standalone,
not wired into `main.bicep`**, same as the Phase 1 modules. A separate account from the
`demistg*` Function-host one, because that account's keys are listed by the runtime and so
cannot have shared-key access disabled. Cool LRS, blob + container soft delete 30 d,
versioning on, `publicAccess: 'None'`, RBAC scoped to the **container**. No key output.

`src/scripts/copy-blobs-to-azure.js` — **dry run by default**; `--live` is required to write
anything. Resumable: a destination blob of matching size is skipped, a truncated one is
recopied, and a short write throws rather than reporting success. The MinIO **write** operation
is not imported at all, and a test greps the compiled-away-comments source to keep it that way
— the source is never written to.

**Nothing has been deployed and nothing has been copied.** ~200 GB Cool LRS is ~$2.20/mo plus
~$0.35 one-time in write operations, and dev already holds the full corpus in MinIO, so this
waits on an explicit go-ahead.

Notes for whoever picks this up:
- `resolveAccess().projectScope` is **live**: it reads `project:<id>` roles from the Keycloak
  token (or an explicit `req.user.projectScope`). Adding a scoped user is a Keycloak role
  assignment — no code change. Every query inherits the restriction automatically.
- **Never call a storage backend directly.** Go through `src/storage/`. Reaching past it is what
  produced the raw-`s3Key` extraction bug and the controllers importing `extract.js`.
- `patch()` is capped at 10 ops by Cosmos and guarded. Use it for partial updates; `upsert()`
  REPLACES the whole item and will erase fields written by another path.
- Point reads bypass the query predicate, so `canRead()` is **mandatory** after `readItem()`.

---

## Verified facts (measured — do not re-derive)

### Sources

| Source | Content |
|---|---|
| **Track** (`src/data/track_projects_enriched.json`, checked in) | **382 projects.** `track_project_id` is authoritative identity. **354 carry `epic_guid`** = the Eagle project `_id` |
| **Eagle** (`eagle-dev…/api/public/search`) | **359 projects** with 60+ fields Track lacks (`eaStatus`, `eacDecision`, `phaseHistory`, `legislation`, contacts, CAC). **60,661 documents.** Carries no Track id — the join is one-directional |
| **NRPTI** (`nrpti-api…/api/public/search`) | **99,430** across 5 datasets. `_epicProjectId` is a deterministic link to an Eagle project **when present — but it usually is not.** See below |
| **epic.submit** | No integration exists. Future work |

**Join:** 348 of 354 Track `epic_guid`s match an Eagle project · 28 Track-only · 6 dangle ·
~10 Eagle-only → **~392 real projects** (vs 4,123 rows today). `buildRegistry` asserts exactly
these counts against the checked-in Track dataset, so upstream drift fails a test.

**Track coordinate defects (found by the Phase 3 tests, not by inspection):** 7 of 382 records
carry a **positive longitude** — a dropped minus sign. BC longitude is always negative, so
`validCoordinates` negates and re-validates against a BC bounding box, recovering 6. The 7th,
`Sparwood Wells #04` (id 358, lat 45.861 lng 53.354), is unrecoverable — Sparwood is at ~49.7,
-114.9, so both values are wrong. It gets **no centroid** rather than an invented one. Without
the sign repair, Zincton plots in Uzbekistan.

### Documents — no copy needed (measured 2026-07-30)

| Environment | Document records | Bucket |
|---|---|---|
| eagle **dev** | **60,661** | `asnpnn` |
| eagle test | 55,845 | `zdspnb` |
| eagle prod | 61,428 | `ozwdez` |

Dev has **more** documents than test, contrary to assumption — 99% of prod. The dev bucket
`asnpnn` holds **92,809 objects / 242.6 GB**, of which **92,472 sit under a prefix named
`ozwdez`** (a full prod copy — hence `minioKeyPrefix`). A blob-coverage check on 100 dev
documents found **100% present, 0 missing**. So DEMI can be tested against the full corpus
today with no copy, and Phase 3b is an architecture choice rather than a prerequisite.

### Current database (to be replaced)

4,123 projects (**3,382 NRPTI-synthetic**), 18,969 documents (a third of Eagle's), 4,045
records (**0 unlinked** → `/projectId` is safe), 244 boundaries, 278 logs, 0 regions,
0 wildfires. **No chunk collection at all** — `document_chunks` and `epic` do not exist, so
Deep Search over content has never had data.

Item sizes: boundaries max **1.58 MB** (Peace River RD; 9 over 1 MB), everything else ≤6 KB.
Cosmos NoSQL caps items at **2 MB** — the 16 MB allowance is MongoDB-API-only, which is what
has been masking this.

---

## Target design

### Containers

| Container | Partition key | Why |
|---|---|---|
| `projects` | `/id` (Track id) | Point reads or full lists; no grouping dimension exists |
| `project_fragments` | `/projectId` | Independently ACL'd slices (e.g. NRPTI aggregates) |
| `documents` | `/projectId` | `?project=X` is the dominant list → single-partition |
| `records` | `/projectId` | 0 unlinked, so no hot empty-string partition |
| `chunks` | `/documentId` | delete-then-reinsert stays single-partition |
| `boundaries` | `/type` | Only filter that exists; 244 items |
| `logs` | `/id` | + 14 d TTL |
| `wildfires` | `/id` | + spatial index, 7 d TTL (stale fires self-expire) |
| `syncState`, `leases` | `/id` | high-water marks; change-feed leases |

Indexing **excludes `/*`**, includes only filtered paths. `/read/[]/?` must be indexed or
every ACL read is a full scan; `/name` must be indexed or `ORDER BY` fails outright.

### Identity & merge

**Implemented in `src/merge/project.js` (Phase 3).** Pure functions, no I/O — merge bugs are
silent, so every rule is data and tested as data.

`id` = `String(track_project_id)`. Cross-refs on every project: `trackProjectId`, `eagleId`
(from Track `epic_guid`, or the Eagle `_id` for eagle-only), `sourceSystem`.
**Track wins, Eagle fills gaps** — `TRACK_PRECEDENCE`, an explicit `[target, trackField,
eagleField]` map. It is a map rather than `{...eagle, ...track}` precisely because a spread
overwrites with `undefined` and would silently erase data: 12 real Track records have no
`abbreviation`, 1 has no `description`, 1 no `address`, 1 no `project_state_name`.
Eagle-only projects are included, flagged `sourceSystem: 'eagle'`, keyed `eagle-<eagleId>`.

| Function | Role |
|---|---|
| `mergeTrackProject(track, eagle)` | one merged item; throws without a `track_project_id` |
| `mergeEagleOnlyProject(eagle)` | an Eagle project Track never referenced |
| `buildRegistry(track[], eagle[])` | `{projects, report}` — the report is the point, it proves nothing was dropped |
| `buildProjectIndex(projects).resolve(ref)` | `_epicProjectId` / Track id → canonical id, or **null** |
| `validCoordinates` / `normalizeCentroid` | GeoJSON `[lng, lat]`, sign repair, BC bbox validation |
| `resolveProjectAcl(eagle, isPublished)` | preserves an upstream `read[]`; fails closed otherwise |

`resolve()` returning null is load-bearing: an unresolvable NRPTI record is **dropped**, never
given a fabricated parent. That is what replaces the fuzzy name matching.

Raw payloads are retained under `sources.track` / `sources.eagle` (unindexed) so a re-merge
never re-fetches upstream and any field is traceable to its origin. Never read by the API.

**NRPTI: do not create projects from NRPTI at all.** Only ingest records whose
`_epicProjectId` resolves to a project already in the registry; drop the rest rather than
inventing a parent. The entire fuzzy-matching apparatus goes with it (`normalizeProjectName`
and its hardcoded "conuma coal"/"chetwynd" cases).

> **Verified 2026-07-30 — the 3,382 NRPTI-seeded "projects" are junk.** 0 have Track
> provenance, 0 have Eagle provenance, all carry synthetic ids ≥ 8,000,000 from
> `8000000 + hash % 1e6`, and **851 share a duplicate name**. Their names are cities and
> watercourses, not EA projects: Kelowna, Victoria, Burnaby, Surrey, Prince George, Kamloops,
> "Cawston / Keremeos Creek", "Cariboo River Provincial Park". The auto-seeder turned every
> unmatched NRPTI `location`/`projectName` string into a project. **They are not re-seeded.**
>
> Consequence: the registry is **~392 real projects**, all published — so in practice **there
> are no hidden projects**, and the 404-for-unauthorised path is unreachable. The ACL stays
> because it still governs documents and future Track drafts (`isPublished: false`).

**Boundaries** store simplified geometry only; full-resolution GeoJSON is a build artifact
already emitted to `frontend/public/assets/geojson/` and already preferred by the frontend.

### The seed (Phase 4 — code written, dry run passes, nothing written)

`src/seed/sources.js` (all I/O) + `src/seed/transform.js` (pure) + `src/scripts/seed-nosql.js`
(orchestrator). **Dry run by default**; `--live` required to write. The gates run in *both*
modes, so a dry run is a real pre-flight check and works from outside the private endpoint.

```
node src/scripts/seed-nosql.js [--live] [--only projects,documents,records,boundaries]
                               [--limit-documents N]
```

Order is forced: projects first, because every other container partitions by a canonical project
id only the merged registry can supply. `--only` still *builds* the registry even when projects
are not written — a stale index would misfile documents into the wrong partition.

**Live dry run against real sources, 2026-07-30:**

```
projects    382 Track + 359 Eagle → 348 matched · 28 no epic_guid · 6 dangling · 11 Eagle-only = 393
documents   60,661 fetched → 60,578 built across 357 projects · 83 dropped · 0 without an object key
boundaries  281: Regional District 28 · Municipality 160 · Electoral District 93
Verification passed
```

**393**, not the estimated ~392 — 11 Eagle-only, not 10. Boundaries are **281 from the static
exports**, not the 244 currently in the database. **83 documents dropped** (0.14% across 19
distinct project refs), not the ~60 extrapolated from a 2,961-document sample.

The `60,661` fetched matches the upstream `searchResultsTotal` exactly, which is what the
truncation guard checks.

#### Streaming, because the accumulating version did not fit the host

The first implementation held all 60,661 raw payloads **plus** their transformed forms: peak RSS
**252 MB by document 45,000 and still climbing**, against a Y1 Consumption plan with 1.5 GB.

Documents and records now stream — `fetchAllPages({accumulate: false})` never builds the array,
and the orchestrator buffers per project and flushes at `FLUSH_THRESHOLD = 100` (the Cosmos bulk
limit, so a full buffer is exactly one request). Measured peak: **123 MB, flat**, with identical
output — same 60,661 / 60,578 / 83 / 357 / 0.

Two consequences worth knowing:

- **The NRPTI aggregate is folded incrementally** (`emptySummary` + `accumulateRecord`), because
  it needs every record but the records are no longer retained. A test asserts
  incremental == whole-list; a divergence there would silently make the aggregate disagree with
  the data it summarises.
- **The page handler is awaited.** Without that the flush-per-page backpressure disappears and
  memory grows unbounded anyway, which is the bug this change exists to prevent. Asserted by test.

Progress is reported **per page, not per dataset**. Inspection alone is 673 pages, and a
per-dataset callback emitted nothing for ~20 minutes — indistinguishable from a hung process.

#### Source facts that changed the transform (all measured, 2,961-document sample)

| Finding | Consequence |
|---|---|
| **`s3Key` is null on 100% of Eagle documents; `internalURL` holds the key** | Reading `s3Key` would seed 60,661 records with no downloadable file |
| **`isPublished` is true on only 66% of documents that are unambiguously public by `read[]`** | `isPublished` is **derived** from `read[]`, never copied. Copying it would hide a third of the corpus |
| `internalSize` is a number OR a numeric string (261 of 2,961 were strings) | coerced via `toNumber` |
| `contentExtracted` is true on 99% upstream, but DEMI has no chunk data at all | **reset to false**; importing it tells the extractor there is nothing to do |
| ~**0.1%** of documents reference a project absent from the public 359 (2024/2025 ObjectIds — unpublished) | dropped **and counted**; a silent drop looks like a complete corpus |
| `pageSize` is **capped at 100** regardless of what is requested | asking for 1000 silently reads a tenth of the data while appearing to work |
| Eagle `type`/`milestone`/`projectPhase` are ObjectId refs into a 213-item `List` | resolved to labels at seed time; an unresolvable ref keeps its raw value rather than becoming null |
| NRPTI uses a **different role vocabulary** (`admin:nrced`, `admin:lng`, `admin:bcmi`) | `read[]` preserved verbatim — these are still role types, and privileged callers short-circuit to `true` anyway |

#### Scope: NRPTI records are not in the default seed (decided 2026-07-30)

`DEFAULT_STAGES` is `projects, documents, boundaries`. `records` remains a valid `--only` value
and the code is kept and tested — it is simply not what DEMI is for right now.

NRPTI records are compliance and enforcement **events**, neither projects nor documents: 67,287
Inspections · 29,555 Tickets · 1,086 Orders · 891 AdministrativePenalties · 611 Certificates.

They *do* carry `documents: [...]` references, which would have made them worth ingesting — but
those ids are unreachable through NRPTI's public API: `dataset=Document` does not respond,
`RecordDocument` returns empty, and `/api/public/document/<id>` returns 404. Dead ends.

And only **2,238 of 99,430 (2.25%)** resolve to a project in the registry, because NRPTI covers all
BC natural-resource compliance rather than only projects that went through an EA. The stage costs
~40 minutes of upstream fetching per seed for data outside the current remit.

#### Safety properties

- **`fetchAllPages` throws on a short count.** A mid-run upstream hiccup returning a partial page
  would otherwise read as end-of-data and quietly seed 40k fewer documents — and the result would
  look complete. Verified against the reported `searchResultsTotal`.
- **An unexpected response envelope throws** rather than reading as zero results and seeding an
  empty database.
- **Gates fail the run with a non-zero exit**: synthetic `trackProjectId >= 8,000,000`, >20
  duplicate names, duplicate ids, any item with no `read[]`, any item with no partition key, and
  any item whose `isPublished` has drifted from `read[]`.
- **`items.bulk` is chunked at 100 inside `cosmos-nosql.js`**, not at the call sites. Cosmos
  rejects more, and a caller that forgot would fail only on the large projects — i.e. in
  production, not in a test.
- The NRPTI aggregate is written to **`project_fragments`** as its own item with
  `read: ['sysadmin','staff','demi-admin','compliance']`. That is simultaneously the 2 MB fix and
  the fragment-ACL mechanism.

`src/scripts/seed-documents.js` was **deleted**: it was hand-written fake documents with fake
chunk text ("Northern Red-legged Frog…"), not a seeder, and had no dependents. The Mongo-era
`seed-and-merge.js` and `sync_from_openshift.js` stay until Phase 5, when they are deleted with
the legacy controllers that still import them.

### Authorization

Two **orthogonal** dimensions — this is the scaling decision:

- **`read[]` holds role *types* only** (`public`, `sysadmin`, `staff`, `project-team`…).
  Bounded, indexed. Putting project identity here would mean a user in 50 projects carrying
  150 roles and every read becoming a cross-partition ACL scan.
- **Project scope rides the partition key.** It is already the partition boundary, so it
  costs nothing extra.

**Scope comes from Keycloak role names** (decided 2026-07-30 — Keycloak dictates all roles, so
there is no separate membership store):

```
project:207        -> scoped to project 207 (a canonical project id = the partition key)
staff, compliance  -> role TYPES, matched against read[]
```

The `project:` prefix is **required**. A bare role name cannot be classified — given `ajax`,
nothing distinguishes "scoped to the Ajax project" from a role type, and guessing would be a
security bug in whichever direction it guessed. `rolesFor()` strips `project:*` from the role
list so a project id can never land in the `read[]` `IN` clause. No project role at all means
**not scoped** (public tier), which is distinct from an explicit `projectScope: []` meaning
**scoped to nothing** (`scopeClause` → `false`). Privileged roles ignore scope entirely.

Scope values are ids, not names, which keeps `resolveAccess` synchronous and lookup-free on
every request. A cached slug→id map would be needed to accept names — noted, not built.

`readClause(roles)` is the only place a visibility predicate is built:

```sql
(EXISTS(SELECT VALUE r FROM r IN c.read WHERE r IN (@role0, @role1))
 OR ((NOT IS_DEFINED(c.read) OR ARRAY_LENGTH(c.read) = 0) AND c.isPublished = true))
```

`EXISTS`-with-subquery, **not `ARRAY_CONTAINS_ANY`** (that one does not use the index).
Legacy tier 3 is **deleted, not translated** — every seeder writes an explicit `read[]`.

Fragment-level control = **make the fragment its own item**, so the same `readClause` applies
unchanged and an unreadable fragment is never fetched.

**Rejected: database-level ACLs driven by Keycloak.** Cosmos NoSQL data-plane RBAC is
Entra-only and its finest scope is a *container* — no item, partition or predicate scoping,
and no row-level security. Resource tokens can scope to a partition key but are key-derived
(incompatible with `disableLocalAuth`), expire in 1–5 h, and cannot express role types or
fragments. The browser never touches Cosmos, so the API is already the trust boundary.
**Keycloak stays for user identity; Entra managed identity is only for app→Cosmos.**

### Typesense (Phase 6 — code written, no reindex run)

`src/typesense/transform-nosql.js` + `full-sync-nosql.js`, selected by the **same**
`USE_COSMOS_NOSQL` flag as the router (`nightly-sync.js` branches on it). The Mongo-era pair stays
until cutover and is deleted with the legacy controllers.

The old transform could not be adapted — it reads fields the NoSQL model does not have:

| Mongo-era | DEMI NoSQL |
|---|---|
| `_id` | `id` |
| `doc.project` | `doc.projectId` (already the canonical Track id) |
| `legislation_2018` / `_2002` / `_1996` blocks | flat merged fields (precedence resolved at seed) |
| `type`/`milestone` as ObjectId refs into `List` | already resolved to **labels** at seed time |
| `sources.nrpti.recordCount` | `project_fragments`, behind its own ACL |

#### Deleted rather than ported — each would have broken the first real sync

- **The `List` lookup and its `MIN_LOOKUP_SIZE` guard.** DEMI has no `List` collection, so the
  lookup returns an empty Map and the guard (`>= 50` in production) **hard-aborts every production
  sync**.
- **The PCP lookup**, plus `transformRecentActivity` and `transformProjectNotification`. Those two
  are in `TRANSFORMS` but **not in `SCHEMAS`**, and the sync iterates `SCHEMAS` — unreachable dead
  code, and the lookup existed only to feed them.
- **The `epic` collection fallbacks.** Each schema probed `projects`/`documents`, then on a **zero
  count** re-queried a catch-all `epic` collection by `_schemaName`. A fallback that fires on an
  empty result turns "the seed failed" into "silently indexed something else".
- **The three-way chunk probe** (`document_chunks` → `documentchunks` → `epic`) — a workaround for
  two writers disagreeing on a collection name.
- **The `test`-database fallback.** Connecting to a *different database* because the configured one
  looked empty is how a dev sync ends up indexing another environment's data.

Kept because each earns its place: the alias swap, orphan purge, disk pre-flight, the
80%-of-previous count guard, and the import retry.

#### Two security decisions

**`systemAccess()`** (new, in `access-sql.js`) is the one context that reads every item regardless
of ACL. It is built from the normal privileged tier and resolves to `true` **through `readClause`**
— not a bypass flag, because a "skip the predicate" path is exactly what disabled access control
here before, and it would not be covered by the SQL-asserting tests. It takes **no arguments**, so
it can never be derived from a request. Safe for the index because Typesense enforces visibility
itself at query time via scoped search keys embedding `filter_by: allowed_roles:=[...]`; the sync's
only security duty is to copy `read[]` into `allowed_roles` faithfully. A test asserts every
repository read in a full sync uses the privileged tier — a non-privileged one would silently index
a subset.

**`nrptiRecordCount` is no longer emitted** onto the project index. The compliance aggregate now
lives in `project_fragments` behind a `compliance` ACL, and the project document is public — so
copying the count there would leak restricted data through search no matter what the fragment's ACL
said. It has **zero consumers** in the frontend, so nothing regresses.

Also enforced in the transform, not just at write time: a child's `allowed_roles` is **intersected**
with its project's (`constrainToProject`), and a chunk inherits its **parent document's**
visibility — a chunk is a fragment of a document, so its text must never be findable when the
document is not. The index is a second copy of the data; a stale or hand-edited child would
otherwise be searchable beyond its project.

An **empty project lookup aborts the sync** rather than proceeding: every child denormalises the
project name, region and ACL, so an empty lookup would index the whole corpus with no project
context. That is the same failure the deleted fallbacks used to paper over.

`allowed_roles` fails closed — an item with no `read[]` and no explicit `isPublished: true` gets
`[]` (matches nothing), never `['public']`.

A test asserts **every field the transforms emit is declared in `collections.js`**: Typesense
rejects an unknown field and fails the entire batch, so a drift between transform and schema would
break a reindex at import time rather than at review time.

### Data access

**No Mongo→SQL translator.** One that handles 90% of operators fails *open* on the rest, and
the operators where the two disagree (`$ne`, `$exists`, `$size`) are exactly what `readFilter`
is built from — this repo has shipped that bug once already. There are only ~12 distinct query
shapes in the whole application.

`query(name, spec, opts)` throws unless the spec is `{query: string, parameters: array}`.
Parameters only, never interpolation.

---

## Operational gotchas (each cost real time)

- **`az functionapp restart` does NOT recycle the Node worker.** App-setting changes appear
  inert. Use `stop` then `start`. Confirmed twice.
- **Cosmos is private-endpoint only** — unreachable from a laptop. Run DB scripts *inside*
  the app via Kudu: `https://demi-api-dev.scm.azurewebsites.net/api/command`, creds from
  `az webapp deployment list-publishing-profiles`. Cloud Shell is not VNet-joined.
  `/api/command` is synchronous and will time out — run detached, log to a file.
- **Deploy zip trap:** pruning `dist` by name at every depth also strips
  `node_modules/**/dist` (e.g. `@mongodb-js/saslprep`), shipping an app that 500s on every
  request. Prune at the repo root only. Already fixed in the workflows.
- **Never ship `.env`** in the deploy package.
- **Cosmos rejects `cursor.sort()` on unindexed fields** and the query layer swallows it into
  `[]` — a silently blank page.
- **`_id` is mixed:** EPIC imports carry real ObjectIds, DEMI-created rows use strings.
- **Object store** is `nrs.objectstore.gov.bc.ca` bucket `asnpnn` (creds in OpenShift secret
  `eagle-api-minio-keys`, ns `6cdc9e-dev`). Needs port 443 + SSL + a **pinned region**, or
  presign hangs ~135 s. There is no MinIO in OpenShift.
- **The OpenShift `eagle-demi-api` pod crash-loops on its own unpaginated `/documents`.**
  Seed documents from `eagle-api` directly.
- **CI is blocked:** `AZURE_CLIENT_ID` missing from repo secrets. Creating the Entra app needs
  Graph, blocked by conditional access. `pr.yaml` only runs on PRs, so backend lint had never
  run before Phase 0.
- `azure-deploy-prod.yaml` and `-test.yaml` trigger on **every push to main**, no tag, no
  approval. Inert today; gate before adding the OIDC credential.

---

## Deliberate deviations from the original plan

- **`tmp/` kept.** The plan said delete it, but it holds two mongodump archives (322 MB).
  Deleting database backups immediately before a re-seed is the wrong moment. Untracked, so
  it does not touch the repo.
- **Phase 1 deployment deferred** on cost (above).
- **New data layer built alongside the old** rather than replacing in place, so the app keeps
  working on Mongo while the NoSQL layer is built and tested.

---

## Verification gates

Every phase: `npm test` and `cd frontend && yarn lint && yarn test && yarn build`.

At cutover, the highest-consequence surface is **authorization**:
- anonymous → only `public` items; a `read:['sysadmin']` document is invisible
- `sysadmin` → everything including unpublished
- **scoped** → items in its projects only; a project outside scope unreachable **by id as well
  as by list**
- **fragment** → project visible, fragment absent and never fetched
- counts use the *identical* WHERE fragment as the read
- **zero rows without `read[]`** — the gate that licenses deleting tier 3
