# DEMI — agent instructions

> **CAVEMAN MODE ALWAYS ACTIVE.** Respond terse. Smart caveman. Technical substance stay. Fluff
> die. Drop articles, fragments OK. Off: "stop caveman" / "normal mode".

DEMI (Document Extraction & Machine Intelligence) for EPIC. Node/Express API + Angular frontend on
**Azure**. Projects and documents in **Cosmos DB for NoSQL**, indexed to Typesense, text extracted
via docling.

## Read `MIGRATION.md` first

`MIGRATION.md` is the source of truth for architecture, environment reality and operational
gotchas, and it is kept current. This file used to carry its own copy of that material; the copy
drifted and ended up describing an architecture that no longer existed — Cosmos DB for **MongoDB**
with a direct connection string, `docling-serve` in RQ mode behind Redis, a Typesense change-stream
daemon, `X-Api-Key`-presence as the authorization model. None of that is true. It is not restated
here, because a second copy is exactly how it went wrong the first time.

Two other root docs were deleted for the same reason — `DEMI_PLAN.md` and
`technical_implementation_plan.md`, both describing a Helm/OpenShift/MongoDB system that was never
built. `git log` has them if the history is ever needed.

## The short version

| | |
|---|---|
| Branch | `main`, push directly |
| Repo | `github.com/digitalspace/eagle-demi` — **PUBLIC**, never hardcode a secret |
| API | `demi-api-dev.azurewebsites.net` — Azure Functions v4, Node 22, Y1 Consumption, `expressApi` catch-all |
| Frontend | `demi-frontend-dev.azurewebsites.net` — Azure Web App, `pm2 serve --spa` |
| DB | `demi-cosmos-dev` — **NoSQL API**, serverless, private endpoint, **keyless** (managed identity) |
| DB (legacy) | `demi-mongo-dev-*` — MongoDB API, **rollback path only**, deleted at Phase 8 |
| Typesense | Container App `demi-typesense-dev` |
| Object store | `nrs.objectstore.gov.bc.ca`, bucket `asnpnn` |
| IaC | Bicep in `azure/main.bicep` and `azure/modules/` |
| RG / sub | `c4b0a8-dev-rg` / `c4b0a8-dev - EPIC.AI` |

**Status: dev only, work in progress.** No test or prod exists. Findings here are backlog, not
incidents.

## Rules that bite

- **All reads compose `src/helpers/access-sql.js`** — `resolveAccess(req)`, then
  `visibilityFor(access, partitionField)`. Point reads bypass the query predicate, so they MUST be
  gated with `canRead()`. Roles come from the verified `req.user` only, never a header or query
  param.
- **`read[]` is authoritative; `isPublished` is a mirror of it**, never an independent signal.
- **The query layer takes spec objects** (`{query, parameters}`) and throws on anything else. There
  is deliberately no Mongo→SQL translator — one that handles 90% of operators fails *open* on the
  rest, which is how access control was disabled here once already.
- **Never touch a storage backend directly** — go through `src/storage/`.
- **`az functionapp restart` does not recycle the Node worker.** Use `stop` then `start`.
- **Never ship `.env`.** App settings supply every variable in Azure.
- Gate before commit: `npm test`, then `cd frontend && yarn lint && yarn test && yarn build`.
- Conventional commits. **Never mention AI/Claude in commits; never add `Co-Authored-By` trailers.**

Everything else — the seeding traps, the deploy quirks, the auth model rationale, the Phase 8
deletion list — is in `MIGRATION.md`.
