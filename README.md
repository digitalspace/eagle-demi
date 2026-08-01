# eagle-demi

DEMI (Document Extraction & Machine Intelligence) for EPIC, on Azure serverless.

This repository houses:

1. **demi-api** — the authoritative REST API and geospatial search service for projects, documents,
   chunks and administrative boundaries, running as an Azure Function App (`@azure/functions` v4 on
   Node.js 22).
2. **demi-frontend** — the Angular document intake and search frontend, deployed to an Azure Web
   App.

> **Status: dev only.** No test or prod environment exists yet. `MIGRATION.md` is the living
> source of truth for architecture, environment reality and operational gotchas — when this file
> and that one disagree, `MIGRATION.md` is right. `TODO.md` holds what is left to do.

---

## Local development

```bash
yarn install
yarn start            # Express on :3000
```

Swagger: `http://localhost:3000/api-docs`

Most database scripts cannot run from a laptop: Cosmos sits behind a private endpoint **and is
keyless**, so they must execute inside the app container over the App Service SSH tunnel — not
Kudu, whose SCM container has no managed-identity endpoint, and not by opening the firewall, which
Azure Policy forbids. `MIGRATION.md` has the full recipe and the four things it needs.

```bash
npm run db:seed-nosql            # dry run by default; --live to write
npm run db:purge-extraction      # dry run by default; --live to write
```

There is no search sync command. Azure AI Search indexers PULL from Cosmos every five minutes on a
`_ts` high-water mark, so nothing has to be pushed to keep the index current.

---

## Architecture

| | |
|---|---|
| API | Azure Functions v4, Node 22, **B1 Basic** (1 vCPU / 1.75 GB, single worker), `expressApi` catch-all |
| Database | **Azure Cosmos DB for NoSQL** (`@azure/cosmos`), account `demi-cosmos-dev` |
| Search | **Azure AI Search** `demi-search-dev` — Basic, keyless, private endpoint only. `demi-chunks`, `demi-projects`, `demi-documents` |
| Object store | `nrs.objectstore.gov.bc.ca`, bucket `asnpnn` (S3-compatible, `minio` client) |
| Frontend | Angular, built to `frontend/dist`, served by `pm2 serve --spa` |
| IaC | Bicep — `azure/main.bicep`, `azure/modules/` |

**The database is keyless.** The account sets `disableLocalAuth`, so there is no connection key:
auth is Entra managed identity via `AZURE_CLIENT_ID`, configured with `COSMOS_ENDPOINT` and
`COSMOS_NOSQL_DATABASE`.

**One data layer.** The MongoDB-API client and everything behind it — `src/db/cosmos.js`,
`src/models/*`, `src/helpers/access.js`, the legacy controllers and the `USE_COSMOS_NOSQL` switch
that chose between them — were deleted at Phase 8. All CRUD lives in `src/repositories/*` and every
read composes `src/helpers/access-sql.js`.

`COSMOS_DATABASE=epic` is still set on the deployed app and is now inert; it goes with the account.
The NoSQL client reads `COSMOS_NOSQL_DATABASE` and deliberately ignores it — pointing it at
`COSMOS_DATABASE` once repointed the live app at an empty database that answered `[]` with HTTP 200.

Some notable implementation details:

- **`api/index.js`** converts Azure Functions v4 `HttpRequest` objects into Node `Readable` streams
  and hands them to Express directly, with no proxy adapter.
- **`src/middleware/rate-limiter.js`** switches to `inlineCleanup` when `isServerless`, avoiding
  `setInterval` timers that leak across execution freeze cycles.
- **There is no nightly sync.** The `nightlySyncTimer` Azure Functions timer is gone, not disabled:
  its script went with the Mongo data layer, and the AI Search indexers pull every five minutes, so
  there is nothing left for a nightly job to push (`api/index.js`).
- **GeoJSON is `[longitude, latitude]`** end to end — Cosmos stores it, AI Search indexes it as a
  `GeographyPoint`, and the API returns it unchanged. The lat/lng swap that Typesense's geopoint
  type required is gone with it.

---

## Text extraction and chunks

Documents are converted to markdown **off-platform** and posted back:

```
POST /api/documents/:id/chunks     { markdown }  |  { error }
```

The server chunks the markdown (`src/chunker.js` is the only chunking implementation) and copies
`read[]` from the **live** document, so an extraction host can never widen a document's visibility.
Chunk ids are deterministic (`<documentId>::p<page>::c<index>`) and `chunks.replaceForDocument`
reconciles, so the route is idempotent and an interrupted backfill simply restarts.

**Nothing inside Azure extracts text today.** `src/extract.js` is the only in-repo docling client
and PDF page-batching code and runs only under `require.main === module`; extraction for new
projects is deliberately deferred, not cancelled. Do not delete it as dead code. `MIGRATION.md` §A
has the reasoning and the pricing that deferred it.

It is also the last thing in the repo that speaks Mongo, so it throws at startup unless a database
is configured rather than falling back to localhost — without that guard, a run after the Phase 8
teardown would connect to nothing and report zero documents as if the corpus were empty.

---

## Authentication & authorization

See [ADR-004: Read ACL Authorization Model](https://github.com/digitalspace/eagle-demi/wiki/ADR-004-Read-ACL-Authorization-Model)
for the full rationale.

**Authentication.** Keycloak (BC Gov loginproxy), realm `eao-epic`. Tokens are verified against
JWKS with `RS256` pinned and the issuer checked (`src/helpers/auth.js`). `KEYCLOAK_URL`,
`KEYCLOAK_REALM`, `SSO_ISSUER` and `SSO_JWKSURI` must be set per environment — they are, in
`azure/modules/api-web-app.bicep`. Without them the API falls back to *dev* realm defaults.

Service-to-service calls use `X-Api-Key`, compared with `crypto.timingSafeEqual`, against
`ADMIN_API_KEY`. **Never hardcode a key literal** — this repository is public, so a literal there
is a world-readable `sysadmin` credential. (`DOCLING_API_KEY` was exactly that until it was split
out; it is now outbound-only and 401s inbound.)

**Authorization — the `read[]` ACL.** Records carry a `read[]` array of role *types*. A record is
visible when `read[]` intersects the caller's roles. `read[]` is authoritative; `isPublished` is a
mirror of it, never an independent signal.

```js
const { resolveAccess, visibilityFor, canRead } = require('../helpers/access-sql');

const access = resolveAccess(req);                 // tier + roles + projectScope
const rows   = await documents.listVisible(access, { projectId });

// Point reads bypass the query predicate — gate them explicitly:
if (!canRead(doc, access, 'projectId')) return res.status(404).json({ error: 'Not found' });
```

A hidden record returns **404, not 403** — a 403 would confirm the id exists.

Project scope is a second, orthogonal dimension: it arrives as Keycloak roles prefixed `project:`
(`project:207`) and rides the partition key. `rolesFor()` strips `project:*` from the role list so
a project id can never enter the `read[]` clause.

`systemAccess()` is the only context that reads past ACLs (chunk ingest, maintenance scripts). It takes no
arguments, so it cannot be derived from a request, and it resolves *through* the same predicate
rather than bypassing it.

### Query layer rules

- `src/db/cosmos-nosql.js` takes **query specs** — `{query, parameters}` — and throws on anything
  else. There is deliberately no Mongo→SQL translator: one handling most operators fails **open**
  on the rest, which is how access control was disabled here once already.
- Counts must use the **same** predicate as the read, or totals leak hidden records.
- **Index before you sort.** Cosmos rejects `ORDER BY` on an unindexed path; add it to
  `azure/modules/cosmos-nosql.bicep` first.

---

## Document storage & downloads

Always go through **`src/storage/`** — four operations (`getBuffer`, `getDownloadUrl`, `putFile`,
`describe`). Never touch a backend client directly; reaching past this module previously produced
two bugs at once.

Backend is chosen by an explicit `STORAGE_BACKEND` (`minio` | `azure`); an unknown value throws at
load. It is never inferred from whichever credentials happen to be present.

MinIO settings: `MINIO_HOST`, `MINIO_BUCKET_NAME`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, plus
**`MINIO_PORT=443`**, **`MINIO_USE_SSL=true`** and a pinned region — without an explicit region the
SDK does a bucket-region lookup on every presign that hangs ~135 s before failing. Dev also needs
**`MINIO_KEY_PREFIX=ozwdez`**: the bucket holds a nested copy of prod, so recorded keys sit one
segment deeper. The prefix is applied inside the backend; callers pass the recorded `s3Key`.

**Downloads:** `GET /api/documents/:id/download` returns a 5-minute presigned URL, gated by the
same ACL as the metadata read — a caller who cannot see a document cannot fetch its bytes.

---

## Project data model

Projects are a merge of two upstream sources, keyed by the Track project id:

- **`sources.track`** — EAO project attributes from EPIC.track (`epictrack-api`), authoritative.
- **`sources.eagle`** — legacy EAGLE portal records, which fill gaps Track does not carry.

Track wins and Eagle fills gaps, via an explicit field map rather than an object spread — a spread
overwrites with `undefined` and silently erases data. `src/merge/project.js` holds the rules and is
pure, because merge bugs are silent.

**Projects are never created from NRPTI.** Compliance records whose `_epicProjectId` does not
resolve to a project already in the registry are dropped and counted, never given an invented
parent. Auto-seeding them is what produced 3,382 synthetic project rows in the old database.

---

## Deployment

```bash
./scripts/deploy-azure.sh all       c4b0a8-dev-rg    # API + frontend
./scripts/deploy-azure.sh api       c4b0a8-dev-rg
./scripts/deploy-azure.sh frontend  c4b0a8-dev-rg
```

GitHub Actions workflows exist for dev/test/prod (`.github/workflows/azure-deploy-*.yaml`) but
**CI cannot currently authenticate** — `AZURE_CLIENT_ID` is missing from repo secrets. The script
above is the working path.

**Only dev deploys on a push to `main`.** Test and prod are `workflow_dispatch` only. They used to
carry the same push trigger, which would have deployed both on every merge with no tag and no
approval the moment the missing credential landed. Do not restore it.

Things that will cost you time if you rediscover them:

- **`az functionapp restart` does not recycle the Node worker.** Use `stop` then `start`.
- **`ENABLE_ORYX_BUILD` must stay `false`** — Oryx runs `yarn install` inside the VNet, which has
  no route to the registry. The zip already ships `node_modules`.
- **Never ship `.env`.** App settings supply every variable in Azure.
- **Verify a deploy by content, not mtime.** The package carries source mtimes, so an old file can
  look freshly deployed.

---

## Frontend

Angular app under `frontend/`, built to `frontend/dist`.

- **Interactive map explorer** over project coordinates and administrative overlays.
- **Static boundary GeoJSON** — `regional_districts.geojson`, `municipalities.geojson`,
  `electoral_districts.geojson` in `frontend/public/assets/geojson/`, checked in. Regenerate with
  `node scripts/export-topological-boundaries.js`, which uses Mapshaper Visvalingam-Whyatt arc
  simplification so adjacent areas share edges with no slivers or overlaps. These files are also
  read at seed time by `src/seed/sources.js`, and `scripts/package-api.py` hard-fails without them.
- **Deep text search** over extracted document chunks, via Azure AI Search.

---

## Related repositories

- [eagle-api](https://github.com/bcgov/eagle-api) — reads read-only cached project/document entries
- [eagle-typesense](https://github.com/digitalspace/eagle-typesense) — the EAGLE-side Typesense sync.
  DEMI no longer uses Typesense: its search moved to Azure AI Search on 2026-07-31
