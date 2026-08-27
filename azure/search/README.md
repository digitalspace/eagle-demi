# AI Search definitions

The index, indexer and data-source definitions for `demi-search-test`, exported from the live
service on 2026-08-04. Until this export they existed **only** on the service — hand-POSTed from
inside the VNet, with nothing in git able to rebuild them.

Bicep creates the search *service*; it cannot create the definitions inside it, because they are
data-plane objects and the data plane is unreachable from outside the VNet. They are here so the
environment is rebuildable and so schema changes show up in a diff.

**`src/scripts/apply-search-definitions.js` applies them.** It is dry-run by default, writes indexes
before indexers, applies an index the app is serving from only when the change ADDS fields, and never
writes a data source. **`--only <name>` narrows a run to one index and its indexer** — `--only
projects` or `--only projects-indexer` both resolve to the same pair — which is what you want when
restoring service, since it leaves the other two untouched. Its header carries the run instructions;
this file stays the reference for what the objects ARE and for the grant they need. Do not restate
one in the other — a duplicated operational doc drifting into a false claim is the failure this repo
has already had.

## The names

**CUT OVER 2026-08-22. These files and the live service now agree** — `chunks`, `projects`,
`documents`. DEMI serves all of EAO, so the product prefix bought nothing.

An index name is immutable, so the rename was a create-and-refill, staged over three changes:
definitions and code defaults first, then the apply script, then the `SEARCH_INDEX*` flip once the
new indexes matched their Cosmos totals (393 / 60,578 / 1,128,733).

**The `demi-*` indexes and indexers were DELETED 2026-08-24** (Search Service Contributor granted
to the app identity at service scope, deleted over the tunnel, grant revoked, identity verified back
to Search Index Data Contributor only). Rollback is no longer a settings flip: it is a refill from
Cosmos with `apply-search-definitions.js --live` + indexer run. The three `demi-*-ds` data sources
stay — they name Cosmos containers and the live indexers use them. Keeping the old set had doubled
every hand PUT and already rotted once (`demi-projects` 12 vs 20 fields).

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
   **That command still applies a WIDENING today** — see the restore section below for what it
   refuses and what to do instead.
3. **The three defaults were flipped** and the template deployed, which is the cutover itself.
   Deploying `api-web-app.bicep` is therefore no longer a no-op: those defaults are what land in the
   live app settings. Rolling back now means refilling under the old names first (they no longer exist).

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

## Adding a field — the order that matters

**Know which kind of change you are making before you start** — the line is not where you would
guess, so take it from the service's own list rather than from intuition
([Update or rebuild an index](https://learn.microsoft.com/en-us/azure/search/search-howto-reindex),
read 2026-08-24):

- **No rebuild:** adding a field; setting `retrievable` on an existing field; `searchAnalyzer` on a
  field that already has an `indexAnalyzer`; adding an analyzer definition; semantic configurations,
  scoring profiles, synonym maps, CORS. A new field is `null` on every existing row until an indexer
  reset re-pulls them.
- **Rebuild — drop and refill:** changing a field's name, data type, or `searchable` / `filterable` /
  `sortable` / `facetable`; assigning `analyzer` or `indexAnalyzer` to an existing field; deleting a
  field; adding an existing field to a suggester.

For `chunks` a rebuild means 1,128,733 rows that cannot be regenerated from Mongo, so the difference
is not academic there. `retrievable` being on the cheap side of that line is what makes hiding
`content` a single PUT rather than a refill.

`fileNameTokens` on `documents` is what that line buys you. `keywords=mine` has to match
`2019-mine-plan.pdf`, and re-analyzing `documentFileName` under the `filename` PatternTokenizer is
squarely on the rebuild side. So the text is added a SECOND time instead: a new
`searchable`/non-retrievable field carrying `c.documentFileName` under the new analyzer, with the
plain column left exactly as it was. Two copies of one string is the cheap half of that trade — the
alternative is dropping and refilling 60,578 rows. `proponentId` is deliberately NOT added the same
way: the value is not in Cosmos until 3.7, and an empty field turns `and[proponent]` from a filter
that is dropped and named in `meta.dropped` into one that is applied and matches nothing — a silent
zero-row 200.

Two service rules met on 2026-08-25 while adding it: `stored: false` is rejected on
`api-version=2024-07-01` (keep `stored: true`), and adding an analyzer or tokenizer to a live index
is refused without `allowIndexDowntime=true` on the PUT — a few seconds offline, so do it, but only
on the index PUT and never as a default in `apply-search-definitions.js`.

Widening an index is three separate writes in three different places, and doing them in the wrong
order takes the live search down for anonymous callers.

1. **PUT the index first** — before deploying the app that ships the widened
   `indexes/documents.json`. `src/search/eagle-query.js` reads field metadata from the committed
   JSON at require time, so an app deployed ahead of the index emits `$orderby datePosted desc`
   against a service with no such field. That is a 400, 400 is not retried, and the controller
   answers 502.
2. **PUT the data source with `src/scripts/put-search-datasources.js`** (packaged; the datasource
   files are not — upload `azure/search/datasources/` to the container and point `DS_DIR` at it;
   run under `with-search-admin.sh`). The committed files carry no credential and no identity; the
   script adds both at PUT time: a `ResourceId=…;IdentityAuthType=AccessToken` connection string
   for the Cosmos account in `COSMOS_ENDPOINT`, and an `identity` block
   (`#Microsoft.Azure.Search.DataUserAssignedIdentity`, `DS_IDENTITY_ID`) because both services run
   their indexers as a user-assigned identity. The block is accepted only on
   `2024-05-01-preview`; `2024-07-01` answers 400 "Cannot find nested property 'identity'". That
   identity needs Cosmos data reader (`…0001`) AND control-plane `Cosmos DB Account Reader Role`
   on the account, or the indexer PUT fails with "Unable to retrieve account endpoint".
   Hand recipe, if the script is unavailable: `apply-search-definitions.js` deliberately never writes one
   (`connectionString` is redacted on export), so the new columns are NOT projected until someone
   sends the file. Until then the indexer keeps its old `SELECT`, the new fields stay `null`, and
   **nothing reports an error** — the apply run says success.

   **You do not need the real credential.** `connectionString: "<unchanged>"` is accepted and
   returns 204, which is how a projection changes without anyone handling the secret the export
   redacts. Send the committed file with that one value swapped.

   **The `DIFFERS` warning cannot fire where you run this, so do not wait for it.** The script
   compares the live `container.query` against the committed copy — but `scripts/package-api.py`
   ships `azure/search/indexes` and NOT `azure/search/datasources`, so inside the container there is
   no committed copy to compare and the run prints `(ds demi-projects-ds ok)` while the data source
   is stale. Measured 2026-08-23. **Verify the live query directly instead**: GET the data source
   before and after and grep the new column out of `container.query`.
3. **Then the indexer.** A schema-only widening re-pulls **nothing** — the high-water mark is
   `_ts`, so existing rows are untouched and the new column stays `null` on every one of them,
   which makes the new filter match zero rows under a 200. The reset is what re-pulls them:

   ```
   POST {endpoint}/indexers/{name}/reset?api-version=2024-07-01    -> 204
   POST {endpoint}/indexers/{name}/run?api-version=2024-07-01      -> 202
   GET  {endpoint}/indexers/{name}/status?api-version=2024-07-01
   ```

   **A 202 means the run STARTED, not that any row moved.** Poll `status` and read
   `lastResult.itemsProcessed` / `itemsFailed` — a reset that re-pulled nothing looks identical to
   one that worked if you stop at the 202. `lastResult.status` passes through `reset` on its way to
   `success`, so treat `reset` as still-running rather than as a terminal state. The projects
   indexer reports `393 processed, 0 failed` when it has done its job.

   A **data-only** change needs none of this: a Cosmos patch moves `_ts`, so the `PT5M` schedule
   picks it up on its own within five minutes — and that path needs **no role grant at all**, which
   matters because `run` is a definition operation and 403s once the grant is revoked.
4. **The app is the LAST step, not the first.** `src/controllers/search.js` routes a keywordless
   search carrying filters or a sort to the index, so deploying it after the index PUT but BEFORE
   the backfill has filled the new columns turns "the filter returns everything" into "the filter
   returns nothing" — quieter than the bug it fixes, and still a 200. Deployed before the index PUT
   it is a 400 that reaches anonymous callers as a 502. Order: **index, data source, backfill,
   indexer reset, app** — the backfill comes BEFORE the reset, or the re-pull carries the nulls it
   was meant to replace and a second reset is needed. (An earlier version of this line had the
   reset before the backfill; it was wrong, and the backfill script's own header had it right.)

Adding a field is an update, not a rebuild — existing documents keep their values and the new field
reads `null` until the indexer has run over them again.

## Restoring one

Public network access is `Disabled` and local auth is off, so this only works from inside the VNet,
as the managed identity — see the SSH-tunnel recipe in the root `README.md`. The identity holds
**Search Index Data Contributor**, which covers documents but *not* definitions; writing these back
needs a temporary **Search Service Contributor** grant, revoked afterwards.

**Use `scripts/with-search-admin.sh` rather than granting by hand.** It grants, runs the command you
give it, and revokes from a `trap` — so the revoke also fires on a failure, on Ctrl-C, and on a
dropped tunnel. Three index changes have each done this by hand, and the failure that costs
something is a grant left standing because the middle step errored. The script's header explains why
the grant stays temporary rather than becoming permanent; the short version is that
`demi-identity-test` is the identity the **public API** runs as.

```bash
scripts/with-search-admin.sh -- \
  sshpass -p "$CONTAINER_SSH_PASSWORD" ssh -c aes256-cbc -m hmac-sha1 -p 50123 root@127.0.0.1 \
  'cd /home/site/wwwroot && node src/scripts/apply-search-definitions.js --live --only projects'
```

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

**`--live` asks whether the change is ADDITIVE, not whether the index is live.** Every committed
name is now a live name, so a blanket refusal made step 1 of "Adding a field" above impossible to
run through the script at all. Adding fields to a live index is supported in place; **a drop, a
retype, a flipped flag, or any index-level change — analyzers, similarity, scoring, suggesters — is
still refused**, because those are rebuilds and doing one to the index the app is querying is an
outage. The run prints `** SERVING TRAFFIC — additive, +N field(s) **` before it writes.

A dry run cannot say which it is: it never reads the live schema. Only `--live` does.

**RESTORING a live index is still by hand**, and that has not changed — a restore replaces a schema
rather than widening one, so the guard is doing its job when it refuses. Note there is no `jq` here,
because the file bodies already carry the right names:

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
`projects` and `documents`. Facets were once thought blocked behind a full reindex, on the grounds
that `facetable` is not a mutable field property. That is true in general, but moot here: the
fields were created facetable. Facets are a query-side change costing nothing but the `facets`
parameter and some UI. The blocker does not exist.
