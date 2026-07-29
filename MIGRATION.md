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
| **2 — Data access + authorization** | ✅ done (`09b35f1`, `d6de8a6`, `+1`) | Client, repositories, controllers, router switch |
| **3 — Merge engine** | ⬜ todo | Track ⊕ Eagle field precedence + identity resolver |
| **4 — Seed** | ⬜ todo | Track → Eagle → documents → NRPTI → boundaries |
| **5 — Cut over** | ⬜ todo | Swap app settings, `stop` then `start` |
| **6 — Typesense** | ⬜ todo | Strip `epic`/List/PCP lookups, export real `fullSync()` |
| **7 — Change feed** | ⬜ deferred | Soft delete + TTL + Functions trigger |
| **8 — Decommission** | ⬜ todo | Delete the Mongo account after a clean week |

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
- `documents.softDelete()` exists because the change feed does **not** emit deletes in
  latest-version mode; a hard delete would strand the document in Typesense forever.

Notes for whoever picks this up:
- `resolveAccess().projectScope` is the **seam** for project-scoped access. It returns null
  today; populating `req.user.projectScope` is the only change needed to activate the scoped
  tier — every query inherits the restriction automatically.
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
| **NRPTI** (`nrpti-api…/api/public/search`) | 67,287 Inspections alone. **`_epicProjectId` populated on 200/200 sampled** — deterministic link to an Eagle project |
| **epic.submit** | No integration exists. Future work |

**Join:** 348 of 354 Track `epic_guid`s match an Eagle project · 28 Track-only · 6 dangle ·
~10 Eagle-only → **~392 real projects** (vs 4,123 rows today).

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

`id` = `String(track_project_id)`. Cross-refs on every project: `trackProjectId`, `eagleId`
(from Track `epic_guid`, or the Eagle `_id` for eagle-only), `sourceSystem`.
**Track wins, Eagle fills gaps** — an explicit field-precedence map, so an empty Track field
never blanks a populated Eagle value. Eagle-only projects included, flagged
`sourceSystem: 'eagle'`.

**NRPTI:** only ingest records whose `_epicProjectId` resolves to a project in the registry.
Auto-seeding of unmatched NRPTI projects is removed, along with the entire fuzzy-matching
apparatus (`normalizeProjectName` and its hardcoded "conuma coal"/"chetwynd" cases).

**Boundaries** store simplified geometry only; full-resolution GeoJSON is a build artifact
already emitted to `frontend/public/assets/geojson/` and already preferred by the frontend.

### Authorization

Two **orthogonal** dimensions — this is the scaling decision:

- **`read[]` holds role *types* only** (`public`, `sysadmin`, `staff`, `project-team`…).
  Bounded, indexed. Putting project identity here would mean a user in 50 projects carrying
  150 roles and every read becoming a cross-partition ACL scan.
- **Project scope rides the partition key.** It is already the partition boundary, so it
  costs nothing extra.

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
