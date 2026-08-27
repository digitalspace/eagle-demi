# Search backend switch

One Mongo field decides which backend eagle-public calls for Project and Document search.
eagle-api serves it from `/api/config`; the browser reads it once per page load.
`/api/config` serves the new value within 19–38 s (measured 2026-08-21); poll up to 60 s before
concluding the change did not land.

## The field

`Config.SEARCH_API_PATH` in the prod `epic` database, document `_schemaName: 'Config'`.

| Value | Meaning |
|---|---|
| `/demi-search` | Live: eagle-public calls `demi-api-prod` for Project/Document search. |
| `''` | Kill switch: eagle-api serves search itself from Mongo. |

## Statements

Run with `mongosh` inside the `eagle-api-mongodb-*` pod in `6cdc9e-prod` (`oc rsh`), root user
from secret `eagle-api-mongodb`, auth db `admin`, database `epic`.

```javascript
// current value
db.epic.findOne({ _schemaName: 'Config' }, { SEARCH_API_PATH: 1 })

// set live or kill switch
db.epic.updateOne({ _schemaName: 'Config' }, { $set: { SEARCH_API_PATH: '<value>' } })
```

## Checks after a change

- `/api/config` returns the new value within seconds.
- `/demi-search/search?dataset=Project&pageSize=1` and `dataset=Document&keywords=assessment&pageSize=1`
  return 200 with `searchResultsTotal` > 0 (only meaningful when the field is `/demi-search`).
- Browser: `/projects` list renders, a document search returns rows, and the network log shows
  calls to the backend the field currently names.
- `dataset=List` is still answered by eagle-api regardless of `SEARCH_API_PATH`.
- `/api/config` 200, `/admin/` 200.

## After a change

Watch for 1 h: the App Insights 5xx rate on `demi-api-prod` and the `demi-search-availability-prod`
webtest. Run the ACL probe against prod explicitly (the script defaults to test):

```
DEMI_API_BASE=https://demi-api-prod.azurewebsites.net ADMIN_API_KEY=<ADMIN_API_KEY from secret demi-app-secrets in 6cdc9e-prod> \
  node src/scripts/probe-acl.js
```

It writes to prod: it plants hidden/control rows, mints two short-lived API keys, exercises 26
cells, then deletes the rows and revokes the keys (the tail of its output confirms the cleanup).
Expect `26 passed, 0 failed`. Use the kill switch (`''`) if search answers 5xx or the probe fails;
the kill switch is reversed the same way.
