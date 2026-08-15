# AI Search definitions

The index, indexer and data-source definitions for `demi-search-test`, exported from the live
service on 2026-08-04. Until this export they existed **only** on the service — hand-POSTed from
inside the VNet, with nothing in git able to rebuild them.

These are not deployed by anything. Bicep creates the search *service*; it cannot create the
definitions inside it, because they are data-plane objects and the data plane is unreachable from
outside the VNet. They are here so the environment is rebuildable and so schema changes show up in
a diff.

## Reading them

| Directory | What it is |
|---|---|
| `indexes/` | Field schemas. `demi-chunks` is the search corpus; `demi-projects` and `demi-documents` are metadata. |
| `indexers/` | The Cosmos-to-index sync jobs. All three run on `PT5M`. |
| `datasources/` | Cosmos NoSQL connections and the `SELECT` each indexer pulls. |

`@odata.etag` is stripped — it is server-assigned and rejected on re-POST. Data-source
`connectionString` is `null` because Azure redacts it on read, not because it is unset; a restore
has to supply it. The export refuses to write any file whose credential came back non-null.

## Restoring one

Public network access is `Disabled` and local auth is off, so this only works from inside the VNet,
as the managed identity — see the SSH-tunnel recipe in the root `README.md`. The identity holds
**Search Index Data Contributor**, which covers documents but *not* definitions; writing these back
needs a temporary **Search Service Contributor** grant, revoked afterwards.

```bash
PUT {endpoint}/indexes/demi-chunks?api-version=2024-07-01
PUT {endpoint}/datasources/demi-chunks-ds?api-version=2024-07-01   # add connectionString first
PUT {endpoint}/indexers/demi-chunks-indexer?api-version=2024-07-01
```

Order matters: an indexer references both its data source and its target index, and fails to create
if either is missing.

## What the export confirmed

- `content` on `demi-chunks` uses analyzer `en.microsoft`. It **was** `retrievable: false`, which is
  what stopped whole chunks leaving the service; semantic ranking requires its configured fields to
  be retrievable, so on 2026-08-05 it flipped to `true` and that guarantee moved into
  `searchChunks`'s `select` list. Highlighting was never affected either way.
- No data source declares a `dataDeletionDetectionPolicy`. The `_ts` high-water mark cannot see
  deletes — measured, and now visible in the definition itself, which is why the app deletes from
  the index directly rather than waiting for the indexer.

## The semantic configuration

`demi-chunks.json` carries `demi-chunks-semantic`, with `content` as the sole
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
`demi-projects` and `demi-documents`. `TODO.md` recorded facets as blocked behind a full reindex on
the grounds that `facetable` is not a mutable field property. That is true in general, but moot
here: the fields were created facetable. Facets are a query-side change costing nothing but the
`facets` parameter and some UI. The blocker does not exist.
