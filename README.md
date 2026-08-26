# eagle-demi

DEMI (Document Extraction & Machine Intelligence) for EPIC, on Azure.

This repository houses:

1. **demi-api** — the authoritative REST API and geospatial search service for projects, documents,
   chunks and administrative boundaries, running on Azure App Service (`@azure/functions` v4 on
   Node.js 22).
2. **demi-frontend** — the Angular document intake and search frontend, published to the `$web`
   container of a Storage static website and served through the Front Door profile that lives in
   `eagle-search`.

> **Status: staging** (`c4b0a8-test`, resources `demi-*-test`) is the live environment — CI
> deploys it on every push to `main`. Dev is an empty sandbox shell (redeploy from Bicep on
> demand; the dev estate was torn down 2026-08-11). Prod comes later, from a tag verified on
> staging.
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
az webapp create-remote-connection -g c4b0a8-test-rg -n demi-api-test --port 50123 &
sshpass -p 'Docker!' ssh -c aes256-cbc -m hmac-sha1 -p 50123 root@127.0.0.1
```

`-c aes256-cbc` is required — App Service offers only legacy CBC ciphers, which OpenSSH 9+ disables
by default (`no matching cipher found`).

**Keep `az` reasonably current, or this tunnel stops working.** The app declares
`basicPublishingCredentialsPolicies` `allow: false` for both `scm` and `ftp`, so SCM refuses basic
auth. `az webapp create-remote-connection` copes: azure-cli checks `basic_auth_supported()` and
falls back to an AAD bearer (verified on 2.89.1). A pre-2023 CLI has no such fallback and loses the
tunnel — which is the ONLY route to the private Cosmos and AI Search data planes, so every database
script goes with it. If the tunnel starts failing to authenticate, check the CLI version before
anything else.

Four things to know before running a script this way:

1. **App settings are injected into the app process, not the SSH shell.** Read them from
   `/proc/1/environ` — and that includes `IDENTITY_ENDPOINT` and `IDENTITY_HEADER`, not just the
   `COSMOS_*` pair. App Service serves managed identity through those two variables, so without them
   `@azure/identity` falls through to IMDS and fails with five `CredentialUnavailableError` lines
   about VS Code, the Azure CLI and PowerShell — none of which is the actual problem:

   ```bash
   export $(tr '\0' '\n' < /proc/1/environ \
     | grep -E '^(COSMOS_ENDPOINT|COSMOS_NOSQL_DATABASE|AZURE_CLIENT_ID|IDENTITY_ENDPOINT|IDENTITY_HEADER|SEARCH_ENDPOINT|SEARCH_INDEX|SEARCH_INDEX_PROJECTS|SEARCH_INDEX_DOCUMENTS)=')
   ```

   The `SEARCH_*` four are here because anything that deletes a row deletes its index entry too, and
   `deleteFromIndex` returns 0 instead of throwing when `SEARCH_ENDPOINT` is unset — without them a
   purge looks like it worked and leaves the row searchable.
2. **`globalThis.crypto` no longer needs shimming.** The container is Node 22, which has it natively;
   `src/app.js` still shims it defensively. Measured 2026-08-20 — earlier advice here said a
   standalone script must do it itself.
3. **Run with `--max-old-space-size=224`.** The container has ~1.85 GB with ~330 MB free, and Node's
   default heap gets the process OOM-killed with no error in the log — it simply vanishes.
4. **`NODE_PATH=/home/site/wwwroot/node_modules`** if you are running from anywhere else in the
   container. `wwwroot` itself is **read-only** (`WEBSITE_RUN_FROM_PACKAGE`), so anything a script
   writes goes under `/home` — which has 30 GB.

**A run longer than ~20 minutes needs `alwaysOn`.** App Service unloads an idle app and recycles the
container, which kills a detached `nohup` run with it. `demi-api-test` ships with `alwaysOn = false`:

```bash
az webapp config set -g c4b0a8-test-rg -n demi-api-test --always-on true
az webapp config set -g c4b0a8-test-rg -n demi-api-test --always-on false  # when the run ends
```

Turn it back off afterwards. `azure/modules/api-web-app.bicep` sets no `alwaysOn` at all, so leaving
it on is drift the template will not correct and the next reader cannot see.

**Getting a large file back out needs `scripts/pull-from-container.sh`**, not `scp` or `cat`:

```bash
scripts/pull-from-container.sh /home/backups/chunks.jsonl.gz ./chunks.jsonl.gz
```

`scp` fails outright — App Service's SSH has no sftp subsystem. `ssh 'cat big.gz' > local.gz` fails
worse, because it fails silently: the tunnel drops mid-stream, the redirect keeps whatever arrived,
and **ssh still exits 0**. Pulling the 2026-08-20 chunk export that way produced 568 MB of a 992 MB
file and reported success. The script splits the file remotely, refetches any part whose md5 does not
match, and checks the assembled result against the container's md5 of the original. Nothing is
written to the destination path until that final md5 matches, so a failed pull leaves no truncated
file behind pretending to be the real one.

Re-running resumes, which on a file this size is the point: the remote split and the verified local
parts (`<destination>.parts`) both survive a failure, so a pull that dies at part 700 of 800 fetches
100 parts on the retry rather than starting over. Both are removed once the whole file checks out.
Splitting doubles the file's footprint under `/home` — and the parts directory does the same
locally — for the duration.

The `_seedwrap.js` / `_purgewrap.js` names that used to be cited here are **not in this repo** —
they were written by hand in the container and are gone with it. The `export $(...)` line above
is the whole pattern; no wrapper is needed now that the crypto shim is not.

```bash
npm run db:seed-nosql            # dry run by default; --live to write
npm run db:seed-nosql -- --reconcile   # also delete rows the fetch did not produce
npm run db:purge-extraction      # dry run by default; --live to write
```

A re-seed **carries extraction state forward**. A Cosmos upsert replaces the item, so the seeder
reads `contentExtracted`, `contentExtractedAt`, `contentPageCount` and `contentExtractionError` out
of each partition before writing it and puts them back on any document it already holds; new ids
start unextracted. The run reports `preserved`.

`--reconcile` (off by default) is the other half: rows that exist in Cosmos but not in the fetch are
deleted through the same helpers `DELETE /documents/:id` and `DELETE /projects/:id` use, so the
chunks and the search-index entries go with them, and each deleted row emits the same
`document.delete` / `project.delete` audit event those routes do. A dry run reports `wouldDelete`
per container and deletes nothing. Deletion is a single phase after every fetch has finished —
documents before projects — so a refusal stops it **before any delete**, in both containers at once.
It refuses — exit 1, nothing removed — if `--only` dropped a stage, if `--limit-documents` was
given, if the Project, ProjectNotification or Document fetch was not verified complete against
eagle-api's `searchResultsTotal`, if a document that resolved to neither a project nor a
ProjectNotification is already in Cosmos (a drop the fetch cannot account for is only at risk when
there is a row to delete; drops absent from Cosmos are reported as `droppedUnresolvable` and do not
refuse), if either container enumerated fewer rows than a `COUNT` of the same predicate reports (a
truncated read is indistinguishable from a container that shrank), or if there is no
`COSMOS_ENDPOINT` to enumerate the containers with: every one of those makes the untouched remainder
look like surplus. A live run also refuses when `SEARCH_ENDPOINT` is unset, for the opposite reason —
the deletes would land in Cosmos and silently no-op against the index, leaving the purged rows
searchable. A dry run reports that as `search: unconfigured — live would refuse` instead.

Every surplus id goes to an NDJSON file — one `{label, id, partitionKey, deleted}` row per surplus
row, both containers, dry run and live — and the run prints the path. It defaults to
`/home/reconcile-<timestamp>.ndjson`, or the working directory where `/home` does not exist;
`RECONCILE_LOG` overrides it. The console line stays capped at the first 20 ids.

There is also a ceiling on how much one reconcile may delete, because a fetch verified only against
itself is not enough — an eagle-api answering `searchResults: [], searchResultsTotal: 0` is
internally consistent and would make the entire corpus surplus. Each container refuses when its
surplus exceeds `max(50, 2% of the rows in it)`; the refusal names the ceiling and the surplus, and
stops **both** containers before any delete, in a dry run too. `--max-surplus <n>` raises the
ceiling to `n` for the run — the operator asserting the loss really is that big. It requires
`--reconcile` and a positive integer.

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
- a scoped caller that is ALSO privileged is narrowed by its scope — privilege lifts the role
  predicate, never the project one
- a staff-only boundary is withheld from anonymous and returned to staff
- counts use the identical `WHERE` fragment as the read
- zero rows come back without a `read[]`

---

## Architecture

| | |
|---|---|
| API | `demi-api-test` — `kind: functionapp,linux` on the **B1 Basic** plan `demi-plan-test` (1 vCPU / 1.75 GB, single worker). Manage with `az webapp` |
| Database | **Azure Cosmos DB for NoSQL** (`@azure/cosmos`), account `demi-cosmos-test` |
| Search | **Azure AI Search** `demi-search-test` — Basic, keyless, private endpoint only. Live indexes `chunks`, `projects`, `documents` since the cutover on 2026-08-22. The retired `demi-*` indexes are still present and still indexing — they are the rollback target (`azure/search/README.md`) |
| Object store | `nrs.objectstore.gov.bc.ca`, bucket `asnpnn` (S3-compatible, `minio` client) |
| Frontend | Angular, built to `frontend/dist`, published to the `$web` container of the `demiweb…` storage account (`azure/modules/static-site.bicep`) and served through the Front Door profile in `eagle-search` |
| Edge | Azure Front Door Standard, profile `eagle-edge-<env>` — **owned by `eagle-search`**, not by this repo. It supplies TLS, the security headers and the SPA fallback rewrite that `$web` cannot |
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

**Service-to-service.** Applications authenticate with a **Keycloak service account** —
`client_credentials` against realm `eao-epic`, then a normal `Authorization: Bearer`. Callers that
cannot hold a Keycloak client use a **registry API key** (`X-Api-Key: demi_<env>_<keyId>_<secret>`),
issued through `POST /admin/api-keys` with its own roles, expiry and revocation. `ADMIN_API_KEY` is
now **break-glass only**: one shared secret with no identity, kept so the first registry key can be
minted and as a way in if the registry is unreachable.

Ask for the least privilege that works. `demi-service-read` reads everything the ACL allows and
cannot write — mutating routes are gated separately by `requireWrite`. See
[ADR-007](https://github.com/digitalspace/eagle-demi/wiki/ADR-007-Service-to-Service-Credentials)
and [Connecting an Application to DEMI](https://github.com/digitalspace/eagle-demi/wiki/Connecting-an-Application-to-DEMI).

**Never hardcode a key literal** — this repository is public, so a literal there is a world-readable
credential. (`DOCLING_API_KEY` was exactly that until it was split out; it is now outbound-only and
401s inbound.)

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

Orthogonal means **both** apply. A privileged credential carrying a scope is privileged *within
those projects*: `readClause` collapses to `true` for the role set while `scopeClause` still
narrows. `resolveAccess` therefore resolves scope BEFORE the privilege check — reversing that order
silently discarded the scope, so a key minted as `roles:['staff'], projectScope:['207']` read the
whole corpus.

A container with no project axis passes a **null** partition field, which makes `scopeClause`
return `true`: boundaries are administrative geography, so the role ACL applies and the project
narrowing does not. Scoping them on a `projectId` the items do not carry would match nothing and
blank the map for every scoped caller.

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

Request paths always go through **`src/storage/`**, which exposes two operations —
`getDownloadUrl` and `putFile`. Reaching past it from a request path previously produced two bugs at
once. The backend modules also export `getBuffer` and `describe`, used only by the one-off scripts
under `src/scripts/`.

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

**Projects are never created from an ingest.** A row whose upstream id does not resolve to a project
already in the registry is dropped and counted, never given an invented parent. Auto-seeding them is
what produced 3,382 synthetic project rows in the old database.

---

## Deployment

**The environment model: Azure dev is a sandbox, test is staging, prod is prod** (decided
2026-08-10). Staging lives in `c4b0a8-test-rg` (subscription `c4b0a8-test`) as `demi-api-test` plus
the `demiwebtest…` static-website storage account, deployed from `azure/main.test.bicepparam`.

`FRONTEND_STORAGE_ACCOUNT` has **no default and cannot be guessed** — the account name carries a
`uniqueString` suffix. Take it from the `frontendStorageAccountName` output of `main.bicep`; the
script aborts rather than inventing one, and `all` therefore needs it too.

```bash
API_APP_NAME=demi-api-test ./scripts/deploy-azure.sh api c4b0a8-test-rg
FRONTEND_STORAGE_ACCOUNT=$(az deployment group show -g c4b0a8-test-rg -n main \
  --query properties.outputs.frontendStorageAccountName.value -o tsv) \
  ./scripts/deploy-azure.sh frontend c4b0a8-test-rg
```

Build the package from a checkout that already has `node_modules` installed — `ENABLE_ORYX_BUILD` is
`false`, so nothing installs dependencies on the Azure side.

### Prod infrastructure

`rg-demi-prod` in `c4b0a8-prod`, from `azure/main.prod.bicepparam`. It deploys no search service —
`demi-search-prod` already exists and also serves `eagle-search-api-prod`, so the template only
grants the DEMI identity Search Index Data Contributor on it and adds the shared private link it
needs to reach the new Cosmos account — and no Foundry account, no `wildfires` container and no
static site. The `boundaries` container IS deployed everywhere, empty in prod: it is reference data
that `GET /boundaries` and `GET /db/stats` read unconditionally.

That shared private link is created in `Pending`. **Approve it once after the apply** or every
indexer fails with a connectivity error, because `demi-cosmos-prod` is `publicNetworkAccess:
Disabled`:

```bash
az cosmosdb private-endpoint-connection list -g rg-demi-prod --account-name demi-cosmos-prod
az cosmosdb private-endpoint-connection approve --id <connection-id>
```

The App Service plan is `plan-eagle-search-prod` in `rg-eagle-search-prod`, shared with
`eagle-search-api-prod` until that app retires. **Scale it to B3 first**: the apply puts a second
Node app on it, and B1 is one worker with 1 vCPU and 1.75 GB.

Object-store credentials come from the `nr-object-store-credential` secret in `6cdc9e-prod`
(`user_account` / `password`), not `eagle-api-minio-keys`. `demi-app-secrets` does not exist in
`6cdc9e-prod` yet — create it, or export `ADMIN_API_KEY` and `DOCLING_API_KEY` by hand.

```bash
# 1. scale the shared plan
az appservice plan update -g rg-eagle-search-prod -n plan-eagle-search-prod --sku B3

# 2. what-if — the default, nothing is applied
./scripts/deploy-infra.sh prod

# 3. apply
CONFIRM_PROD=yes ./scripts/deploy-infra.sh prod --live
```

`--live` is required to apply in every environment; prod additionally refuses without
`CONFIRM_PROD=yes`.

### `demi-frontend-test` is gone — decommissioned 2026-08-15

The App Service and the B1 plan it shared with eagle-public's preview were deleted once the Front
Door endpoint was verified in a browser. Two things from that generalise, and one is repo-specific:

- **Deleting a module stops ARM *managing* a resource; it does not delete it.** `what-if` reports
  the orphan as `Ignore` and it keeps running and billing. Complete-mode would remove it and is
  **not** an option here — it deletes everything in `c4b0a8-test-rg` absent from the template,
  Cosmos and AI Search included. Orphans go by hand or not at all.
- **Take the origin out of `frontendHostNames` before deleting the host.** An `*.azurewebsites.net`
  name returns to Azure's global pool on deletion, so an entry left in `CORS_ORIGIN` is a
  cross-origin position against `demi-api-test` that someone else can register.
- `demi-api-test` was never on that plan — it runs on `demi-plan-test`, which is unaffected. Worth
  checking before any future plan deletion here, because the two names differ by one token.

### Three manual steps the templates cannot do

Do these once per environment, in this order, or the frontend is a set of blobs nobody can reach.

Two things that used to be on this list are now automatic, and are recorded here only so nobody
re-adds them. `frontendUploaderPrincipalId` is **set** in `azure/main.test.bicepparam`
(`39682a03-…`, the object id of `demi-cicd-test` — not its client id), so `static-site.bicep`
assigns the CI identity both roles it needs. And **static website hosting is enabled by
`scripts/deploy-azure.sh frontend` on every deploy**, idempotently:

```bash
az storage blob service-properties update --account-name <frontendStorageAccountName> \
  --auth-mode login --static-website --index-document index.html --404-document index.html
```

Both documents are `index.html` because this is an SPA; skip it and every blob uploads fine while
the site 404s. That is a *service-properties* write, so it needs **Storage Account Contributor**,
which Blob Data Contributor does not imply — `static-site.bicep` now assigns it alongside the data
role. Handing CI a role carrying `listKeys` is only acceptable because the account sets
`allowSharedKeyAccess: false`, which makes those keys unusable; do not re-enable shared keys
without revisiting that grant. `scripts/validate-deploy.sh` checks the result when given
`FRONTEND_STORAGE_ACCOUNT`.

1. **Give eagle-search the origin hostname.** `main.bicep` outputs `frontendStaticSiteHostName`
   (`demiweb….z13.web.core.windows.net`); it goes into eagle-search's `demiFrontendWebHostName`
   parameter, which is what adds DEMI's route to the shared Front Door profile.

2. **Add the AFD hostname to `frontendHostNames` BEFORE publishing the frontend to it.** An AFD
   endpoint is `<name>-<hash>.<zone>.azurefd.net` and **Azure assigns both the hash and the zone
   code**, so it cannot be composed, guessed or written ahead of the deployment. Take it from
   eagle-search's `edgeEndpointHostNames` output, append it to `frontendHostNames` in
   `azure/main.test.bicepparam`, and redeploy this template. That is what sets `CORS_ORIGIN` on
   `demi-api-test`, and it also sets the App Service's own platform CORS — **both layers, and the
   platform one answers the preflight first**, so neither alone is enough.

   The parameter is an ARRAY because a cutover has two frontends at once. Getting the order wrong
   is not theoretical: on 2026-08-15 the AFD frontend was published while this still named only the
   App Service, and the result was a site that loaded perfectly and then failed every single
   request — `/api/config` and both `/api/search` calls blocked with *"No
   'Access-Control-Allow-Origin' header is present"*. Nothing in either deployment reported a
   problem, because nothing in either deployment was wrong. **List the new origin first, publish
   second, drop the old origin last.**

   An empty array is the pre-Front-Door state and fails closed: `CORS_ORIGIN` is unset, `src/app.js`
   falls back to an allowlist holding only `http://localhost:4200`, and the frontend's first XHR
   fails loudly rather than silently reflecting any origin.

3. **Register the AFD hostname with Keycloak, before decommissioning the old App Service.**
   This is the one step with no code anywhere in these repos, and nothing fails loudly enough to
   point at it. `registry-state.service.ts` derives both `redirectUri` and
   `silentCheckSsoRedirectUri` from `window.location.origin`, so moving the frontend to a new
   hostname changes both. The client's registered URIs are **exact-host patterns**, so an
   unregistered host gets `400 Invalid parameter: redirect_uri` from the realm's authorize endpoint —
   which means CORS and CSP can all be correct on cutover day and staff still cannot log in. Probe it
   directly before believing otherwise; the test environment's AFD host was registered on 2026-08-14
   and staff login confirmed working the same day.

   **This does not need another team.** The `demi-keycloak-admin` secret in `6cdc9e-test` holds
   credentials that can update the client directly, and doing so is a single admin-API call. Read
   the client, append to `redirectUris` and `webOrigins`, PUT the whole object back — appending to
   what you just read is the only safe shape, because the API replaces the arrays it is given and a
   hand-written one silently drops the other dozen entries. Add, on client `eagle-admin-console` in
   realm `eao-epic`, in the realm matching the environment's `KEYCLOAK_URL`:

   - Valid Redirect URIs: `https://<afd-endpoint>/*` — covers both `/` and `/silent-check-sso.html`
   - Web Origins: `https://<afd-endpoint>` — the token and userinfo XHRs are checked against this

   **Keep the existing `demi-frontend-<env>.azurewebsites.net` entries until the cutover is
   verified**, so a rollback to the App Service still logs in.

   Failure signature if this is skipped: clicking Log In lands on Keycloak's
   `Invalid parameter: redirect_uri` error page. Worse, once a user has `isLoggedIn` set on the new
   origin the same rejection happens inside the hidden silent-SSO iframe, where it is invisible —
   the `Promise.race` times out after 5s and the app settles into public mode showing no staff-only
   data, with nothing in the console but a blocked navigation.

### Two accepted ceilings

- **The `$web` endpoint stays publicly reachable, so Front Door can be bypassed.** Accepted; the
  reasoning lives once in `eagle-search`'s README, which owns the Front Door profile and both
  storage accounts. The copy that used to be here had already drifted from it.
- **Nothing in front of the frontend authenticates.** `$web` is anonymous by definition, and an AFD
  rule-set rule can only rewrite and set headers — no action challenges a request for credentials.
  DEMI's own Keycloak login still gates staff data, since it is in the app, but the shell is open to
  anyone with the hostname. Note that login is not automatically carried over: the new origin has to
  be registered on the Keycloak client first — step 3 above. The upgrade that keeps this SKU is a **WAF custom rule** on the endpoint (match +
  Block, e.g. an IP CIDR); Standard supports custom rules, and only *managed* rule sets are
  Premium-only.

**CI deploys staging on every push to `main`.** It runs the same script — the
workflow installs dependencies, logs in, and calls `./scripts/deploy-azure.sh`, so CI and a manual
deploy cannot drift.

The frontend and the API are **separate workflows with separate triggers**, so a change to one does
not redeploy the other:

| Workflow | Deploys | Fires on a push to `main` touching |
|---|---|---|
| `azure-deploy-staging-frontend.yaml` | `$web` on the static-website storage account (repo variable `AZURE_FRONTEND_STORAGE_ACCOUNT`) | `frontend/**` |
| `azure-deploy-staging-api.yaml` | `demi-api-test` | `src/**`, `api/**`, `public/**`, `index.js`, `host.json`, `package.json`, `yarn.lock`, `frontend/public/assets/geojson/**` |
| `draft-release.yaml` | nothing — mints the tag and draft release for the same push (see [Releases](#releases)) | *any path* |

**The two staging workflows stay separate, and `draft-release.yaml` is a third.** Folding the deploys
into one "Deploy to Test" was considered and rejected: they have different path filters, different
concurrency groups, different Node versions, different Azure targets under different RBAC (Website
Contributor on a Function App vs Storage Blob Data Contributor on `$web`), and only the frontend
rewrites `env.js`. One workflow would have to re-derive "did the frontend change?" at runtime to keep
the current behaviour, which is the coupling the 2026-08-05 split removed. Tagging is the one thing
that must happen once per push regardless of paths, so it lives in the workflow that has no path
filter.

All three also accept `workflow_dispatch`. The API's paths mirror `scripts/package-api.py`, which decides
what actually ships — root `public/` is not excluded there, and `frontend/public/assets/geojson/**`
is explicitly re-included because the boundary seeder reads it at runtime, so that one path fires
both workflows. Adding a directory to the package without adding it here gives you a deploy that
silently never runs.

GitHub Actions authenticates as the user-assigned managed identity **`demi-cicd-test`** through a
federated credential, with no client secret anywhere:

| | |
|---|---|
| Identity | `demi-cicd-test`, in `c4b0a8-test-rg` |
| Federated credential | issuer `https://token.actions.githubusercontent.com`, subject `repo:digitalspace/eagle-demi:environment:test`, audience `api://AzureADTokenExchange` |
| RBAC | Website Contributor on `demi-api-test` **individually** — and, until that app is deleted, on `demi-frontend-test` as well — plus Storage Blob Data Contributor (publish the bundle) **and** Storage Account Contributor (enable static website hosting) on the static-website account — both assigned by `static-site.bicep` from `frontendUploaderPrincipalId`. Nothing at resource-group scope. Website Contributor gives nothing at all on a storage account, and the data role alone cannot turn `$web` on |
| Config | All four values live on the **`test` GitHub environment**, nothing at repo scope and nothing hardcoded: secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`; variables `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP` |

**Declaring `environment: test` changes the OIDC subject claim, and that is the trap.** With an
environment the claim becomes `repo:digitalspace/eagle-demi:environment:test` rather than
`repo:digitalspace/eagle-demi:ref:refs/heads/main`. The subject is the whole contract; it is not
derived from anything the workflow can set. Rename the environment, or delete the `gh-env-test`
federated credential, and Azure Login fails with `AADSTS700213: No matching federated identity
record found for presented assertion subject` — so always create the credential for the new subject
before renaming, prove a deploy green, and only then remove the old one. (The dev-era `demi-cicd-dev`
identity and its `gh-main`/`gh-env-staging` credentials go away with the dev teardown.)

**A managed identity, deliberately, not an app registration.** A UAMI carries federated credentials
just as an Entra application does, but creating and configuring one is pure ARM. The app-registration
route needs Microsoft Graph to create the service principal and the credential, and conditional
access blocks Graph here — browser sign-in has no browser on a server, and device-code flow is denied
tenant-wide. The landing zone points the same way: managed identity first, app registration only for
human sign-in, multi-tenant or M365 integration, and by request rather than self-service.

`demi-cicd-test` is separate from the runtime identity `demi-identity-test` on purpose. The runtime
identity holds Cosmos Data Contributor, Search Index Data Contributor and OpenAI User; a federated
credential on it would let any workflow on `main`, in a **public** repo, mint a token with full
database access.

The script carries no credential of its own — `az account get-access-token` returns a token for
whatever principal the CLI session holds, a human locally and the managed identity in CI. Its
`preflight_identity` prints that principal and refuses to run under `GITHUB_ACTIONS` as anything but
a service principal, so a deploy authenticated as a person fails instead of proceeding.

**The prod deploy workflow is back**: `.github/workflows/azure-deploy-prod.yaml`,
`workflow_dispatch` only, taking a `version` and checking out `refs/tags/<version>` — a tag verified
on staging, never a branch. Both jobs declare `environment: prod`, which is what produces the OIDC
subject `repo:digitalspace/eagle-demi:environment:prod`; renaming the environment breaks the
federated credential. An earlier note here said no prod workflow existed, which was true only
between 2026-08-05 and the prod estate being built.

Its last job, `publish-release`, flips that version's draft release to published and marks it latest.
It runs only when every deploy job has succeeded, holds `contents: write` and nothing else, and
declares no `environment:` — it touches no Azure resource, and a second approval gate in front of
"record that the approved deploy finished" would be theatre. See [Releases](#releases).

Recreating them is not a copy job. Each environment needs its own managed identity, its own federated
credential — subject `repo:digitalspace/eagle-demi:environment:test` or `:environment:prod`, matching
its GitHub environment — its own role assignments, and for prod a decision about required reviewers
on the environment. Build them from the dev pair when that work actually starts.

**`azure/main.bicep` now describes and manages staging**, and was first applied to `c4b0a8-test-rg`
on 2026-08-13. It instantiates every module except `vnet.bicep` — the landing zone owns the VNet, and
secrets are app settings rather than Key Vault references. (`static-web-app.bicep` and
`frontend-web-app.bicep` used to be named here as well; both were deleted when the frontend moved to
`static-site.bicep`. `key-vault.bicep` is gone too — unreferenced, with no Key Vault in any
environment.)

That first apply found two defects the template had carried for months, both invisible to
`what-if`:

- `documents` and `boundaries` declared `/id/?` in their Cosmos `indexingPolicy`. Cosmos rejects the
  whole policy — `id` is a system property, always indexed, and cannot be named in a policy — so the
  module could never deploy. `what-if` does not validate indexing rules.
- `main.bicep` did not pass `adminApiKey` or `doclingApiKey` to `api-web-app.bicep`, so the module's
  `''` defaults would have overwritten `ADMIN_API_KEY` and `DOCLING_API_KEY` in live app settings.
  `what-if` masks `@secure()` values, so it showed nothing.

The second one is the general lesson: **a clean `what-if` is not evidence that an apply is safe.**
It cannot see secure parameters and it does not validate resource-provider rules. Read the diff for
secrets by hand before applying, and round-trip the live values in.

It is not a loaded gun, though, and now for two independent reasons. **No dev workflow contains an
infra job at all** — the `deploy-infra` job became a loginless `validate-infra` on 2026-08-04, and
that in turn moved to `pr.yaml` as `validate-bicep` on 2026-08-05 when the deploy workflows were
split. A template that will not compile is a pull-request problem; it has no bearing on whether a
zipdeploy should run, so it no longer blocks one. And the CI identity is scoped to one App Service
plus a data-plane role on one storage account, so it could not run an ARM deployment even if a job
came back. Infrastructure changes go through `az` by hand meanwhile.

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

## Releases

**Two workflows, and the tag is cut at test time.** This is the paradigm the other Azure repos are
meant to copy, so the shape matters more than the details:

| | Workflow | Does |
|---|---|---|
| **test** | `draft-release.yaml` + the two `azure-deploy-staging-*.yaml` | Every push to `main` **mints a git tag**, refreshes the single draft release for it, and deploys that push to staging |
| **prod** | `azure-deploy-prod.yaml` | Dispatched with a version, deploys `refs/tags/<version>`, and **publishes that release as its last step** |

**The tag exists before anything is deployed.** That is the change: a draft release mints no git ref,
so under the previous model the build running on staging had no name and "deploy the tag you verified
on staging" could not be obeyed until a human had already published it. Publishing therefore meant
"somebody intends to ship this". Now the tag is minted alongside the draft, the prod workflow deploys
it, and **publishing means the version is in production**. Nothing else publishes — do not click
Publish in the UI.

The cost is deliberate: **a version is spent on every push to `main`**, and tags accumulate for
candidates that never reach prod. A tag is a 40-byte ref, and the payoff is that every staging build
is addressable — including for a rollback, which is just a dispatch naming an older tag.

**Versions are computed, never typed.** `scripts/next-version.js` reads the commit messages between
the **highest existing tag** and the commit being built, then applies conventional-commit rules to
the whole set: a breaking change bumps major, otherwise any `feat` bumps minor, otherwise patch. A
breaking change is `!` before the `:`, or a `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer line in the
body; both spellings are normative and both are honoured. **While the major is `0` a breaking change
bumps the minor instead** — a stray `refactor!:` must not mint `v1.0.0` on a product that has never
shipped to prod.

The base is the highest **tag**, not the latest published release. With a tag per push, a base that
only saw published releases would recompute the same number every push and collide with the tag it
had just created. A side effect worth knowing: ticking *Set as the latest release* on an older
release no longer moves the version base backwards, which used to be a live trap.

The bump range and the **release-notes** range are therefore different, on purpose.
`--generate-notes` infers its own start, which is the last *published* release — the last version
that actually reached production. So the notes on the candidate that ships carry the work of every
candidate that did not, which is the right answer to "what is new in prod".

`draft-release.yaml` maintains **exactly one draft release**, deleting and recreating it each run, so
**any hand-edit to the draft body is lost on the next push**; write release prose in the commits
instead. Deleting a draft never deletes its tag — `gh release delete` is run without `--cleanup-tag`,
and that flag must never be added, since it would destroy the previous candidate's tag on every push.
A tag whose draft has been superseded is still deployable; if prod deploys one, the publish step
creates the published release itself.

Once a first release exists, `git describe --tags` resolves and the deploy script stamps
`BUILD_ID` as `v0.1.1-3-gabc1234-121314`, reported at `GET /api/config`. Before that it is a bare
SHA, exactly as today.

**Before any of this can run, the seed release must exist.** It is created once, by hand, and
deliberately without `--generate-notes` — with no prior release GitHub has no start boundary for
note generation and would emit notes for all ~296 commits in the repository:

```bash
gh release create v0.1.0 --repo digitalspace/eagle-demi \
  --target main --title "v0.1.0" \
  --notes "Baseline: the state of staging as of the first tagged release."
```

Create it **before** this automation lands on `main`, or the first *Tag and draft release* run fails:
the script has no first-run path at all, by design. Every later version is computed against a real
predecessor, which is what removes the untestable "no previous release" branch from the script.
Publishing that seed is what puts the `v0.1.0` tag in place; from there the workflow tags on its own.

`release-drafter` was the closest off-the-shelf fit and was rejected on a specific point: its
`version-resolver` reads **pull-request labels** and its notes are assembled from **merged PRs**.
This repository sometimes pushes straight to `main`, and such a commit carries no PR — it would
affect neither the notes nor the version bump, silently.

---

## Repository security

Enabled 2026-08-05. The repo is **public**, so all of this is free — none of it needs an Advanced
Security licence.

| | |
|---|---|
| Secret scanning | Scans the full history on every branch. Zero alerts |
| **Push protection** | Blocks a push containing a recognised credential, instead of reporting it once it is already public |
| Dependabot alerts + security updates | Opens PRs for advisories; no config needed for that part |
| Code scanning | CodeQL default setup — `actions`, `javascript-typescript`, `python`. No workflow file to maintain |

**Push protection is the enforcement behind "never ship `.env`".** That rule was previously a
convention, and this repository has already shipped a `.env` carrying `MONGODB_PASSWORD`,
`TYPESENSE_API_KEY`, `MINIO_SECRET_KEY` and `DOCLING_API_KEY` into `wwwroot` once.
`scripts/package-api.py` excludes `.env` at every depth; push protection stops it a step earlier, at
the commit. Note it only blocks pattern types with low false-positive rates — it is a backstop, not
a substitute for keeping secrets in app settings.

`secret_scanning_validity_checks`, `non_provider_patterns` and `ai_detection` are deliberately off:
unlike push protection, those sit behind paid Secret Protection.

**Reading the Dependabot count.** The raw number overstates the exposure. Only `frontend/dist` is
deployed, never `frontend/node_modules`, so advisories on the Angular build toolchain are a CI
supply-chain concern and not a production one. The API is the opposite — its package includes
`node_modules`, so a root-lockfile advisory does reach `demi-api-test`. Group by
`dependency.manifest_path` and `dependency.scope` before deciding anything:

```bash
gh api "repos/digitalspace/eagle-demi/dependabot/alerts?state=open&per_page=100" \
  --jq '[.[]|{man:.dependency.manifest_path,scope:.dependency.scope,
              fixable:(.security_vulnerability.first_patched_version!=null)}]
        |group_by(.man+.scope)|map({manifest:.[0].man,scope:.[0].scope,n:length})'
```

Grouping and routine version updates come from `.github/dependabot.yml`. Angular is no longer
ignored there — the freeze was lifted on 2026-08-06 with the move to Angular 22 — but it is still
grouped, because the framework and its toolchain are version-locked and a half-bumped pair does not
build. See the Angular entry in `TODO.md`.

**GitHub Code Quality is not enabled.** It went GA on 2026-07-20 and bills $10 per active committer
per month, counted org-wide, and it is not in the free public-repo set. It is also UI-only, with no
REST API, so it cannot be scripted. CodeQL above provides the same analysis engine at no cost.

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
