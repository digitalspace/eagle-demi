# eagle-demi

DEMI (Document Extraction & Machine Intelligence) for EPIC, on Azure.

This repository houses:

1. **demi-api** — the authoritative REST API and geospatial search service for projects, documents,
   chunks and administrative boundaries, running on Azure App Service (`@azure/functions` v4 on
   Node.js 22).
2. **demi-frontend** — the Angular document intake and search frontend, deployed to an Azure Web
   App.

> **Status: dev only.** No test or prod environment exists yet.
>
> This file covers what you need at the keyboard. Architecture, measured facts, Azure environment
> detail and the traps live in the [wiki](https://github.com/digitalspace/eagle-demi/wiki) — start at
> [Environment Reality & Operational Gotchas](https://github.com/digitalspace/eagle-demi/wiki/Environment-Reality-and-Operational-Gotchas).
> `TODO.md` holds what is left to do.

---

## Local development

```bash
yarn install
yarn start            # Express on :3000
```

Swagger: `http://localhost:3000/api-docs`

### Running anything against the database

Cosmos sits behind a private endpoint **and is keyless**, so database scripts cannot run from a
laptop. They also cannot run in Kudu — the SCM container has no managed-identity endpoint, and with
local auth disabled there is no key to fall back on. Opening the firewall is denied by Azure Policy.

The app container is the only place with both network access and a managed identity. Reach it over
the App Service SSH tunnel:

```bash
az webapp create-remote-connection -g c4b0a8-dev-rg -n demi-api-dev --port 50123 &
sshpass -p 'Docker!' ssh -c aes256-cbc -m hmac-sha1 -p 50123 root@127.0.0.1
```

`-c aes256-cbc` is required — App Service offers only legacy CBC ciphers, which OpenSSH 9+ disables
by default (`no matching cipher found`).

Four things any script run this way needs:

1. **App settings are injected into the app process, not the SSH shell.** Read them from
   `/proc/1/environ`.
2. **`globalThis.crypto` must be shimmed.** `src/app.js` does it for the web app, but a standalone
   script never loads `app.js`, and the Azure SDKs need it on Node 22.
3. **Run with `--max-old-space-size=224`.** The container has ~1.85 GB with ~330 MB free, and Node's
   default heap gets the process OOM-killed with no error in the log — it simply vanishes.
4. **`NODE_PATH=/home/site/wwwroot/node_modules`** if you are running from anywhere else in the
   container.

The `_seedwrap.js` / `_purgewrap.js` pattern in this repo handles 1–3.

```bash
npm run db:seed-nosql            # dry run by default; --live to write
npm run db:purge-extraction      # dry run by default; --live to write
```

There is no search sync command. Azure AI Search indexers pull from Cosmos every five minutes on a
`_ts` high-water mark, so nothing has to be pushed to keep the index current. Deletes are the
exception — the high-water mark cannot see them, so the application removes index entries explicitly.

---

## Tests

Run both halves. This is the gate for every change.

```bash
npm test
cd frontend && yarn lint && yarn test && yarn build
```

Authorization is the highest-consequence surface, so those tests assert behaviour rather than
implementation:

- anonymous sees only `public` items; a `read: ['sysadmin']` document is invisible
- `sysadmin` sees everything, including unpublished
- a scoped caller sees items in its projects only, and a project outside scope is unreachable by id
  as well as by list
- a fragment's parent project is visible while the fragment itself is absent and never fetched
- counts use the identical `WHERE` fragment as the read
- zero rows come back without a `read[]`

---

## Architecture

| | |
|---|---|
| API | `demi-api-dev` — `kind: functionapp,linux` on the **B1 Basic** plan `demi-plan-dev` (1 vCPU / 1.75 GB, single worker). Manage with `az webapp` |
| Database | **Azure Cosmos DB for NoSQL** (`@azure/cosmos`), account `demi-cosmos-dev` |
| Search | **Azure AI Search** `demi-search-dev` — Basic, keyless, private endpoint only. `demi-chunks`, `demi-projects`, `demi-documents` |
| Object store | `nrs.objectstore.gov.bc.ca`, bucket `asnpnn` (S3-compatible, `minio` client) |
| Frontend | Angular, built to `frontend/dist`, served by `pm2 serve --spa` |
| IaC | Bicep — `azure/main.bicep`, `azure/modules/` |

**The database is keyless.** The account sets `disableLocalAuth`, so there is no connection key: auth
is Entra managed identity via `AZURE_CLIENT_ID` and `COSMOS_ENDPOINT`.

**One data layer.** The MongoDB-API client and everything behind it — `src/db/cosmos.js`,
`src/models/*`, `src/helpers/access.js`, the legacy controllers and the `USE_COSMOS_NOSQL` switch —
were deleted at Phase 8. All CRUD lives in `src/repositories/*` and every read composes
`src/helpers/access-sql.js`.

The NoSQL client reads `COSMOS_NOSQL_DATABASE` and deliberately ignores `COSMOS_DATABASE`. Pointing
it at the latter once repointed the live app at an empty database that answered `[]` with HTTP 200.

Some implementation details worth knowing before you touch them:

- **`api/index.js`** converts Azure Functions v4 `HttpRequest` objects into Node `Readable` streams
  and hands them to Express directly, with no proxy adapter.
- **`src/middleware/rate-limiter.js`** switches to `inlineCleanup` when `isServerless`, avoiding
  `setInterval` timers that leak across execution freeze cycles.
- **There is no nightly sync.** The `nightlySyncTimer` is gone, not disabled — the indexers pull every
  five minutes, so there is nothing left for a nightly job to push.
- **GeoJSON is `[longitude, latitude]`** end to end. Cosmos stores it, AI Search indexes it as a
  `GeographyPoint`, and the API returns it unchanged.

Fuller detail: [Architecture](https://github.com/digitalspace/eagle-demi/wiki/Architecture).

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

> **Do not change `TARGET_CHUNK_SIZE`, `MAX_CHUNK_SIZE` or `OVERLAP_SIZE`.** Chunk ids derive from
> the split, so changing a constant orphans every chunk already written instead of reconciling with
> it. If a chunker change is unavoidable, it lands together with every other pending chunker change
> in a single re-ingest — never two.

Two transport constraints on this route, both found from real documents rather than tests:

- **Send `Content-Length`, never a chunked body.** App Service does not forward a
  `Transfer-Encoding: chunked` body to the Node worker; it arrives as an empty stream and the app
  answers 400, which reads like a malformed payload rather than a transport problem. In Python
  `requests`, pass bytes, never a generator.
- **App Service's request timeout is 240 s and applies to streaming writes.** Four concurrent 30 MB
  ingests on one B1 vCPU returned 504; serialising to one uploader took the same document to 111 s.

Documents whose markdown exceeds the 10 MB JSON body limit use `Content-Type: application/x-ndjson`
on the same route — line 1 provenance, lines 2..n JSON-encoded markdown blocks. `express.json` only
parses `application/json`, so the body arrives unconsumed. Both paths share `createChunkAccumulator`,
so a document chunks identically whichever door it came through.

**Nothing inside Azure extracts text today.** `src/extract.js` holds the only in-repo docling client
and PDF page-batching code; extraction for new projects is deliberately deferred, not cancelled. Do
not delete it as dead code.

It is a **library, not a worker**. The Mongo-driven loop around those two functions was deleted on
2026-08-04 along with the `mongodb` dependency it was the last user of. Reviving extraction means
writing a new driver against Cosmos NoSQL and reusing `splitAndExtract`; it does not mean restoring
the old one.

`extraction-host/` holds the vendored source of the off-platform GPU backfill host. It is Python this
app never loads, and `scripts/package-api.py` excludes it from the deploy package.

---

## Authentication & authorization

See [ADR-004: Read ACL Authorization Model](https://github.com/digitalspace/eagle-demi/wiki/ADR-004-Read-ACL-Authorization-Model)
for the full rationale.

**Authentication.** Keycloak (BC Gov loginproxy), realm `eao-epic`. Tokens are verified against JWKS
with `RS256` pinned and the issuer checked (`src/helpers/auth.js`). `KEYCLOAK_URL`, `KEYCLOAK_REALM`,
`SSO_ISSUER` and `SSO_JWKSURI` must be set per environment — they are, in
`azure/modules/api-web-app.bicep`. Without them the API falls back to *dev* realm defaults.

Service-to-service calls use `X-Api-Key`, compared with `crypto.timingSafeEqual`, against
`ADMIN_API_KEY`. **Never hardcode a key literal** — this repository is public, so a literal there is
a world-readable `sysadmin` credential. (`DOCLING_API_KEY` was exactly that until it was split out;
it is now outbound-only and 401s inbound.)

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
(`project:207`) and rides the partition key. `rolesFor()` strips `project:*` from the role list so a
project id can never enter the `read[]` clause.

`systemAccess()` is the only context that reads past ACLs (chunk ingest, maintenance scripts). It
takes no arguments, so it cannot be derived from a request, and it resolves *through* the same
predicate rather than bypassing it.

### Query layer rules

- `src/db/cosmos-nosql.js` takes **query specs** — `{query, parameters}` — and throws on anything
  else. There is deliberately no Mongo→SQL translator: one handling most operators fails **open** on
  the rest, which is how access control was disabled here once already.
- Counts must use the **same** predicate as the read, or totals leak hidden records.
- **Index before you sort.** Cosmos rejects `ORDER BY` on an unindexed path; add it to
  `azure/modules/cosmos-nosql.bicep` first.
- `patch()` is capped at 10 ops. `upsert()` replaces the whole item and will erase fields written by
  another path.
- Paging uses continuation tokens, not skip/take.

---

## Document storage & downloads

Always go through **`src/storage/`** — four operations (`getBuffer`, `getDownloadUrl`, `putFile`,
`describe`). Never touch a backend client directly; reaching past this module previously produced two
bugs at once.

Backend is chosen by an explicit `STORAGE_BACKEND` (`minio` | `azure`); an unknown value throws at
load. It is never inferred from whichever credentials happen to be present. It is set explicitly to
`minio` on `demi-api-dev` (2026-08-04) rather than resting on the default in `src/config.js`.

MinIO settings: `MINIO_HOST`, `MINIO_BUCKET_NAME`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, plus
**`MINIO_PORT=443`**, **`MINIO_USE_SSL=true`** and a pinned region — without an explicit region the
SDK does a bucket-region lookup on every presign that hangs ~135 s before failing. Dev also needs
**`MINIO_KEY_PREFIX=ozwdez`**: the bucket holds a nested copy of prod, so recorded keys sit one
segment deeper. The prefix is applied inside the backend; callers pass the recorded `s3Key`.

**Downloads:** `GET /api/documents/:id/download` returns a 5-minute presigned URL, gated by the same
ACL as the metadata read — a caller who cannot see a document cannot fetch its bytes.

---

## Project data model

Projects are a merge of two upstream sources, keyed by the Track project id:

- **`sources.track`** — EAO project attributes from EPIC.track (`epictrack-api`), authoritative.
- **`sources.eagle`** — legacy EAGLE portal records, which fill gaps Track does not carry.

Track wins and Eagle fills gaps, via an explicit field map rather than an object spread — a spread
overwrites with `undefined` and silently erases data. `src/merge/project.js` holds the rules and is
pure, because merge bugs are silent.

**Projects are never created from NRPTI.** Compliance records whose `_epicProjectId` does not resolve
to a project already in the registry are dropped and counted, never given an invented parent.
Auto-seeding them is what produced 3,382 synthetic project rows in the old database.

---

## Deployment

```bash
./scripts/deploy-azure.sh all       c4b0a8-dev-rg    # API + frontend
./scripts/deploy-azure.sh api       c4b0a8-dev-rg
./scripts/deploy-azure.sh frontend  c4b0a8-dev-rg
```

Build the package from a checkout that already has `node_modules` installed — `ENABLE_ORYX_BUILD` is
`false`, so nothing installs dependencies on the Azure side.

**CI deploys dev on every push to `main`**, working since 2026-08-05. It runs the same script — the
workflow installs dependencies, logs in, and calls `./scripts/deploy-azure.sh`, so CI and a manual
deploy cannot drift.

GitHub Actions authenticates as the user-assigned managed identity **`demi-cicd-dev`** through a
federated credential, with no client secret anywhere:

| | |
|---|---|
| Identity | `demi-cicd-dev`, client `37ff78d5-23b0-49bc-b324-02ff63755da1` |
| Federated credential | issuer `https://token.actions.githubusercontent.com`, subject `repo:digitalspace/eagle-demi:ref:refs/heads/main`, audience `api://AzureADTokenExchange` |
| RBAC | Website Contributor on `demi-api-dev` and `demi-frontend-dev` **individually** — nothing at resource-group scope |
| Repo secrets | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`. The subscription id is a literal in the workflow `env:` |

**A managed identity, deliberately, not an app registration.** A UAMI carries federated credentials
just as an Entra application does, but creating and configuring one is pure ARM. The app-registration
route needs Microsoft Graph to create the service principal and the credential, and conditional
access blocks Graph here — browser sign-in has no browser on a server, and device-code flow is denied
tenant-wide. The landing zone points the same way: managed identity first, app registration only for
human sign-in, multi-tenant or M365 integration, and by request rather than self-service.

`demi-cicd-dev` is separate from the runtime identity `demi-identity-dev` on purpose. The runtime
identity holds Cosmos Data Contributor, Search Index Data Contributor and OpenAI User; a federated
credential on it would let any workflow on `main`, in a **public** repo, mint a token with full
database access.

The script carries no credential of its own — `az account get-access-token` returns a token for
whatever principal the CLI session holds, a human locally and the managed identity in CI. Its
`preflight_identity` prints that principal and refuses to run under `GITHUB_ACTIONS` as anything but
a service principal, so a deploy authenticated as a person fails instead of proceeding.

Only dev has an identity. Test and prod workflows read the same secrets but `demi-cicd-dev` has no
role in those subscriptions, so they authenticate and then fail on authorization. Each environment
needs its own.

**Only dev deploys on a push to `main`.** Test and prod are `workflow_dispatch` only. They used to
carry the same push trigger, which would have deployed both on every merge with no tag and no
approval. That was inert only while no credential existed; one exists now, so do not restore it.

**`azure/main.bicep` does not describe the running environment.** It never instantiates
`cosmos-nosql.bicep`, `ai-search.bicep`, `identity.bicep`, `document-storage.bicep` or
`frontend-web-app.bicep`, and there is no VNet in the resource group. Rewriting it is open work.

It is not a loaded gun, though, and now for two independent reasons. `azure-deploy-dev.yaml`'s
`deploy-infra` job was replaced by `validate-infra` on 2026-08-04, which runs `az bicep build` and
nothing else — the login and `arm-deploy` steps are gone, so it is validation-only by construction
rather than by lack of auth. And the CI identity is scoped to two App Services, so it could not run
an ARM deployment even if a login step came back. Both app-deploy jobs still gate on it, so a broken
template blocks a release. Infrastructure changes go through `az` by hand meanwhile.

Things that will cost you time if you rediscover them:

- **`az webapp restart` does not recycle the Node worker.** Use `stop` then `start` — and even then,
  poll a discriminator until it flips. A warm worker served the old build after both, for minutes.
- **`config-zip` merges rather than clean-deploys.** A file deleted from the repo will not disappear
  from `wwwroot`.
- **Verify a deploy by content, not mtime.** The package carries source mtimes, so an old file can
  look freshly deployed.
- **Never ship `.env`.** App settings supply every variable in Azure.

More, including the Kudu and basic-auth situation, in
[Environment Reality & Operational Gotchas](https://github.com/digitalspace/eagle-demi/wiki/Environment-Reality-and-Operational-Gotchas).

---

## Frontend

Angular app under `frontend/`, built to `frontend/dist`.

- **Interactive map explorer** over project coordinates and administrative overlays.
- **Static boundary GeoJSON** — `regional_districts.geojson`, `municipalities.geojson`,
  `electoral_districts.geojson` in `frontend/public/assets/geojson/`, checked in. Regenerate with
  `node scripts/export-topological-boundaries.js`, which uses Mapshaper Visvalingam-Whyatt arc
  simplification so adjacent areas share edges with no slivers or overlaps. These files are also read
  at seed time by `src/seed/sources.js`, and `scripts/package-api.py` hard-fails without them.
- **Deep text search** over extracted document chunks, via Azure AI Search.

---

## Related repositories

- [eagle-api](https://github.com/bcgov/eagle-api) — reads read-only cached project/document entries
- [eagle-demi wiki](https://github.com/digitalspace/eagle-demi/wiki) — architecture, measurements,
  Azure environment, ADRs
