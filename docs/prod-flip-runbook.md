# Prod search flip: `/eagle-search` → `/demi-search`

One Mongo field decides which backend eagle-public calls for Project and Document search.
eagle-api serves it from `/api/config`; the browser reads it once per page load. Propagation
measured 2026-08-21: 19–38 s. Nothing deploys in either direction.

The operator runs the Mongo statements (prod write); the checks are run from this repo's scripts and a browser.

## Preconditions (all verified 2026-08-26)

- `projects.eao.gov.bc.ca/demi-search/search?dataset=Project&pageSize=1` → 200 from `demi-api-prod`
  (rproxy `v2.7.17`).
- `demi-search-prod` indexes `chunks`/`projects`/`documents` populated; chunk count equals the
  `chunks` container count (check after the copy).
- eagle-public bundle `main-BTVKQ45Y.js` (`v2.7.31`) served on `projects.eao.gov.bc.ca`.
- `probe-acl.js` 26/26 against `demi-api-prod`; `search-diff.js` shows only the known DIFFs.

## Statements

Run with `mongosh` inside the `eagle-api-mongodb-*` pod in `6cdc9e-prod` (`oc rsh`), database `epic`.

```javascript
// current value
db.epic.findOne({ _schemaName: 'Config' }, { SEARCH_API_PATH: 1 })

// flip
db.epic.updateOne({ _schemaName: 'Config' }, { $set: { SEARCH_API_PATH: '/demi-search' } })

// revert
db.epic.updateOne({ _schemaName: 'Config' }, { $set: { SEARCH_API_PATH: '/eagle-search' } })

// kill switch: eagle-api/Mongo serves search itself
db.epic.updateOne({ _schemaName: 'Config' }, { $set: { SEARCH_API_PATH: '' } })
```

## Rehearsal (timeboxed 5 minutes): flip → checks → revert

1. Baseline: `curl -s https://projects.eao.gov.bc.ca/api/config | grep -o '"SEARCH_API_PATH":"[^"]*"'`
   → `/eagle-search`. Save the full body to compare after revert.
2. Operator: flip.
3. Checks: poll `/api/config` until it says `/demi-search` (≤ 60 s), then:
   - `/demi-search/search?dataset=Project&pageSize=1` and `dataset=Document&keywords=assessment&pageSize=1`
     → 200 with `searchResultsTotal` > 0.
   - Browser (playwright, real bundle): `/projects` list renders, a document search returns rows, the
     network log shows calls to `/demi-search/search`, none to `/eagle-search/search`.
   - `dataset=List` still answered by eagle-api (`/api/search?dataset=List` 200).
   - ACL: an anonymous document search returns no item whose parent project is unpublished
     (`probe-acl.js` anonymous cells).
   - `/api/config` 200, `/admin/` 200.
4. Operator: revert. Check: `/api/config` byte-identical to step 1.

## Real flip

Same as rehearsal without step 4. Then watch 24 h: App Insights 5xx on `demi-api-prod`,
`demi-search-availability-prod` webtest, eagle-api pod logs. Rollback at any sign: revert statement.

Soak criterion and daily record: `TODO.md` §4.8 (single source).
