# Search backend switch

One Mongo field decides which backend eagle-public calls for Project and Document search.
eagle-api serves it from `/api/config`; the browser reads it once per page load.
Propagation: seconds.

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
</content>
