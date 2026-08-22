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

## The names, and why they do not match the live service

These files say `chunks`, `projects` and `documents`. The indexes on `demi-search-test` are still
called `demi-chunks`, `demi-projects` and `demi-documents`. **That is deliberate, and it is not
drift.** DEMI serves all of EAO, so the product prefix buys nothing and the plain names are what the
service should carry; but an index name is immutable, so "renaming" one means creating a second
index and refilling it, and the chunk corpus cannot be rebuilt from anything outside Cosmos.

So the rename is staged, and this is stage one — definitions and code defaults only:

1. **This change.** Definitions take the plain names. `SEARCH_INDEX`, `SEARCH_INDEX_PROJECTS` and
   `SEARCH_INDEX_DOCUMENTS` all exist as app settings in `azure/modules/api-web-app.bicep`, and all
   three are **pinned to the old `demi-` names**, so deploying it changes nothing the app queries.
2. **From inside the VNet**, run `node src/scripts/apply-search-definitions.js --live` on Kudu. It
   creates the three plain-named indexes from these files and then the indexers, in that order,
   and lets them fill on their PT5M schedule. The old indexes keep serving the whole time.
3. **Settings only.** Flip the three defaults. No code release, and rolling back is flipping them
   back — which is the entire reason step 1 made all three configurable rather than just the chunk
   index, which was the only one with an app setting before.

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

**THE NAME IN THE FILE IS NOT THE NAME ON THE SERVICE, and restoring the wrong one CREATES rather
than restores.** These definitions were renamed to the plain `projects` / `documents` / `chunks`
ahead of the cutover; the live service still runs `demi-projects` / `demi-documents` /
`demi-chunks`, and will until the `SEARCH_INDEX*` app settings are flipped. A `PUT` to the file's
own name during an incident makes a SECOND, EMPTY index that nothing queries, leaves the broken one
in place, and consumes partition storage — a worse outage than the one being fixed.

So restore against whatever `az functionapp config appsettings list -n demi-api-<env>` reports
today, not against the filename. While the settings still say `demi-*`:

```bash
# Read the live names FIRST. Do not take them from this file.
az functionapp config appsettings list -n demi-api-test -g c4b0a8-test-rg \
  --query "[?starts_with(name,'SEARCH_INDEX')].{name:name,value:value}" -o table

# Then PUT the definition under the name that is live, overriding the body's own `name`:
# THREE rewrites on the index, not one. The semantic configuration name must track the index name
# or every chunk search answers 400 — semantic is on by default for chunks and 400 is not retried.
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
guards it for the committed files. Once the cutover lands, all of this collapses — the file names,
the live names and the configuration name agree, and the `jq` rewrites go away.

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
