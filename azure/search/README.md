# AI Search definitions

The index, indexer and data-source definitions for `demi-search-dev`, exported from the live
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

- `content` on `demi-chunks` is `retrievable: false`, analyzer `en.microsoft`. Highlighting still
  works on a non-retrievable field, which is why the API can return a snippet but never the whole
  chunk.
- No data source declares a `dataDeletionDetectionPolicy`. The `_ts` high-water mark cannot see
  deletes — measured, and now visible in the definition itself, which is why the app deletes from
  the index directly rather than waiting for the indexer.

## What it contradicted

**`sector`, `region` and `status` are already `facetable: true`** — as is every other field in
`demi-projects` and `demi-documents`. `TODO.md` recorded facets as blocked behind a full reindex on
the grounds that `facetable` is not a mutable field property. That is true in general, but moot
here: the fields were created facetable. Facets are a query-side change costing nothing but the
`facets` parameter and some UI. The blocker does not exist.
