# AI Search definitions

The index, indexer and data-source definitions for `demi-search-test`, exported from the live
service on 2026-08-04. Until this export they existed **only** on the service — hand-POSTed from
inside the VNet, with nothing in git able to rebuild them.

Bicep creates the search *service*; it cannot create the definitions inside it, because they are
data-plane objects and the data plane is unreachable from outside the VNet. They are here so the
environment is rebuildable and so schema changes show up in a diff.

**`src/scripts/apply-search-definitions.js` applies them.** It is dry-run by default, writes indexes
before indexers, refuses to touch an index the app is currently serving from, and never writes a data
source. Its header carries the run instructions; this file stays the reference for what the objects
ARE and for the grant they need. Do not restate one in the other — a duplicated operational doc
drifting into a false claim is the failure this repo has already had.

## The names

**CUT OVER 2026-08-22. These files and the live service now agree** — `chunks`, `projects`,
`documents`. DEMI serves all of EAO, so the product prefix bought nothing.

An index name is immutable, so the rename was a create-and-refill, staged over three changes:
definitions and code defaults first, then the apply script, then the `SEARCH_INDEX*` flip once the
new indexes matched their Cosmos totals (393 / 60,578 / 1,128,733).

**The `demi-*` indexes still exist and their indexers are still running.** They are the rollback
target: flipping the three `SEARCH_INDEX*` settings back is the whole rollback, with no refill,
because those indexers never stopped. Do not delete them until the new names have soaked.

The staged history — all three steps are DONE. Past tense on purpose: the rollback walks it
backwards, so the reader doing that needs to know what each step did.

1. **Definitions took the plain names**, and `SEARCH_INDEX`, `SEARCH_INDEX_PROJECTS` and
   `SEARCH_INDEX_DOCUMENTS` became app settings in `azure/modules/api-web-app.bicep`. They were
   pinned to the old `demi-` names at that point, so that deploy changed nothing the app queried.
   Only two of the three had ever been settings before, which is why a settings-only cutover was
   impossible until then.
2. **The indexes and indexers were created** from these files by
   `node src/scripts/apply-search-definitions.js --live`, run from inside the app container over
   the App Service SSH tunnel (not Kudu — its SCM container has no managed-identity endpoint; see
   the root `README.md` recipe). They filled on their PT5M schedule to
   393 / 60,578 / 1,128,733 while the old indexes kept serving.
   **That command will REFUSE now** — see the restore section below for why, and for what to do
   instead.
3. **The three defaults were flipped** and the template deployed, which is the cutover itself.
   Deploying `api-web-app.bicep` is therefore no longer a no-op: those defaults are what land in the
   live app settings. Rolling back is flipping them back and deploying again — no data step, because
   the `demi-*` indexers never stopped.

`src/search/eagle-query.js`'s `DATASET_INDEX` is the one thing that moves in step 1 rather than
step 3: it is a **schema** lookup naming which file in `indexes/` to read field types from, never a
wire name, and `test/search/eagle-query.test.js` pins that every value it holds is a file on disk.
Getting that wrong does not fail — `fieldsFor` returns an empty map and every filter and sort is
silently dropped under a 200.

## Reading them

| Directory | What it is |
|---|---|
| `indexes/` | Field schemas. `chunks` is the search corpus; `projects` and `documents` are metadata. |
| `indexers/` | The Cosmos-to-index sync jobs. All three run on `PT5M`. |
| `datasources/` | Cosmos NoSQL connections and the `SELECT` each indexer pulls. |

`@odata.etag` is stripped — it is server-assigned and rejected on re-POST. Data-source
`connectionString` is `null` because Azure redacts it on read, not because it is unset; a restore
has to supply it. The export refuses to write any file whose credential came back non-null.

**The data sources keep their `demi-` names and are not part of the rename.** A data source names a
Cosmos container, never an index, so the same `demi-chunks-ds` feeds both the old indexer and the
new one — there is nothing in it that a rename would correct. Renaming one would mean re-POSTing
it, and that means someone handling the `connectionString` the export deliberately redacts, for no
change in behaviour. Old and new indexers share them.

## Restoring one

Public network access is `Disabled` and local auth is off, so this only works from inside the VNet,
as the managed identity — see the SSH-tunnel recipe in the root `README.md`. The identity holds
**Search Index Data Contributor**, which covers documents but *not* definitions; writing these back
needs a temporary **Search Service Contributor** grant, revoked afterwards.

**READ THE LIVE NAMES FIRST — never take them from a filename.** Since the cutover the two agree, so
a `PUT` under the file's own name is correct today. That was NOT true before it, and it stops being
true the moment anyone rolls back: the settings would then say `demi-*` while these files still say
the plain names, and a `PUT` under the filename would create a SECOND, EMPTY index that nothing
queries, leave the broken one in place, and consume partition storage — a worse outage than the one
being fixed.

```bash
# ALWAYS start here. One command, and it settles which branch below applies.
az functionapp config appsettings list -n demi-api-test -g c4b0a8-test-rg \
  --query "[?starts_with(name,'SEARCH_INDEX')].{name:name,value:value}" -o table
```

**If the settings report the plain names** (the state since 2026-08-22), start with the dry run. It
touches nothing and it works in every state, and it marks which indexes are serving:

```bash
node src/scripts/apply-search-definitions.js
```

**`--live` will REFUSE**, and that is deliberate: every committed name is now a live name, so
re-applying would rewrite a schema serving traffic. The script is for CREATING these objects, not
for restoring one that is live. To restore a live index you are knowingly overriding that guard, so
do it by hand — and note there is no `jq` here, because the file bodies already carry the right
names:

```bash
PUT {endpoint}/indexes/chunks?api-version=2024-07-01           # body indexes/chunks.json
PUT {endpoint}/datasources/demi-chunks-ds?api-version=2024-07-01   # add connectionString first
PUT {endpoint}/indexers/chunks-indexer?api-version=2024-07-01  # body indexers/chunks-indexer.json
```

The data source keeps its `demi-` name — data sources were never renamed, both old and new indexers
share them, and `connectionString` comes back redacted on export.

**If the settings report `demi-*`** — i.e. someone rolled back — the filename is wrong and the body
must be rewritten before it is sent. Three rewrites on the index, not one: the semantic
configuration name must track the index name or every chunk search answers 400, since semantic is on
by default for chunks and 400 is not retried.

```bash
jq '.name = "demi-chunks"
    | .semantic.configurations[].name = "demi-chunks-semantic"' \
      indexes/chunks.json          > /tmp/idx.json
jq '.name = "demi-chunks-indexer"
    | .targetIndexName = "demi-chunks"' indexers/chunks-indexer.json > /tmp/ixr.json

PUT {endpoint}/indexes/demi-chunks?api-version=2024-07-01           # body /tmp/idx.json
PUT {endpoint}/datasources/demi-chunks-ds?api-version=2024-07-01    # add connectionString first
PUT {endpoint}/indexers/demi-chunks-indexer?api-version=2024-07-01  # body /tmp/ixr.json
```

That third `jq` clause is the one worth understanding rather than copying: the app derives the
configuration name from whichever index it is configured with (`semanticConfigurationFor`), so the
definition has to follow the same `<index>-semantic` convention. `test/search/eagle-query.test.js`
guards it for the committed files. The rewrites did NOT go away when the cutover landed — they moved
to the rollback branch, which is the one state where the filename and the live name disagree again.

Order matters: an indexer references both its data source and its target index, and fails to create
if either is missing.

## What the export confirmed

- `content` on `chunks` uses analyzer `en.microsoft`. It **was** `retrievable: false`, which is
  what stopped whole chunks leaving the service; semantic ranking requires its configured fields to
  be retrievable, so on 2026-08-05 it flipped to `true` and that guarantee moved into
  `searchChunks`'s `select` list. Highlighting was never affected either way.
- No data source declares a `dataDeletionDetectionPolicy`. The `_ts` high-water mark cannot see
  deletes — measured, and now visible in the definition itself, which is why the app deletes from
  the index directly rather than waiting for the indexer.

## The semantic configuration

`chunks.json` carries `chunks-semantic`, with `content` as the sole
`prioritizedContentFields` entry — there is no title or keywords field to prioritise, because
`content` is the only searchable field in the index. The other two indexes have no semantic
configuration and must not be sent one: naming a configuration that does not exist is a 400.

Adding it was a **no-rebuild** change. `retrievable` and semantic configurations are the two named
exceptions to Azure's drop-and-rebuild rule, so nothing was re-extracted and nothing re-indexed —
the same applies if it ever has to be reverted. A PUT still needs the temporary **Search Service
Contributor** grant, and still carries the complete schema, which is why this file has to stay
accurate.

Measured on the live index rather than assumed: **L2 reads `content` even though the query's
`select` excludes it.** Microsoft's transparency note says the reranker "cannot reach back to the
search index to access other fields… that weren't returned in the query response", which would have
forced `content` into `select` and made the API ship whole chunks. It is loose wording — the
how-it-works page is right that inputs come from the fields named in the semantic *configuration*.
Ten hits came back with ten distinct `@search.rerankerScore` values under the app's real `select`.

## What it contradicted

**`sector`, `region` and `status` are already `facetable: true`** — as is every other field in
`projects` and `documents`. `TODO.md` recorded facets as blocked behind a full reindex on
the grounds that `facetable` is not a mutable field property. That is true in general, but moot
here: the fields were created facetable. Facets are a query-side change costing nothing but the
`facets` parameter and some UI. The blocker does not exist.
