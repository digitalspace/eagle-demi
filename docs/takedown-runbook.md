# Takedown runbook

For a privacy breach or a record published in error, and nothing else. A routine correction is an
ordinary narrow through `PUT /:id/level` and stops at step 1.

## 1. Narrow the record

As `sysadmin` — no other role may pull a record back off level 4.

```
PUT /api/projects/:id/level     { "level": 2, "reason": "personal information published in error" }
PUT /api/documents/:id/level    { "level": 2, "reason": "..." }
```

Level 2 is staff-only; use level 1 if EAO staff must not see it either. The route writes a
`record.takedown` audit row with your name and that reason, rewrites the row's ACL in AI Search, and
patches the document's chunks. On a project it cascades to every document in it.

## 2. Purge the search index

Step 1 leaves the row in the index under a narrowed ACL. Removing it outright is `deleteFromIndex`
plus `deleteChunksForDocument` in `src/search/ai-search.js`; nothing runs them on a schedule,
because AI Search indexers are a `_ts` high-water mark and never see a delete.

What calls them today: `src/helpers/purge.js`, behind `DELETE /api/documents/:id` and
`DELETE /api/projects/:id`. That deletes the Cosmos record too, so use it only when the record must
not exist. For chunks alone, `node src/scripts/purge-extraction.js`. No path touches the stored file
in object storage.

## 3. Invalidate the Front Door cache

Test: profile `eagle-edge-test` in `c4b0a8-test-rg`, endpoint `demi-frontend-test`. Prod: profile
`eagle-edge-prod` in `rg-eagle-public-prod` — TODO: confirm the DEMI endpoint name from `eagle-edge`.

```
az afd endpoint purge -g <rg> --profile-name <profile> --endpoint-name <endpoint> \
  --content-paths '/documents/<id>' '/api/documents/<id>'
```

## 4. Accept what cannot be recalled

Downloads, mirrors and search-engine caches outside EPIC are unrecoverable. Record that in the
incident, do not treat the steps above as reaching them.

## 5. Verify

Anonymous `GET /api/documents/:id` returns 404, and the record is absent from
`GET /api/search?dataset=Document&keywords=<term>`. Both anonymous — an authenticated check proves
nothing.
