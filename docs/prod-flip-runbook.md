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

Pulling a published record back from the public is a different procedure: `takedown-runbook.md`.

## Rotating ADMIN_API_KEY

Owner: Daniel Truong — the only holder of a prod write login, and the only person who can run
`CONFIRM_PROD=yes ./scripts/deploy-infra.sh prod --live`.

`ADMIN_API_KEY` is a Key Vault reference on the App Service, not a stored value. The app setting
reads `@Microsoft.KeyVault(SecretUri=https://demi-kv-prod.vault.azure.net/secrets/admin-api-key)`
— versionless, so a new secret version is picked up without an infrastructure deploy.

Order matters. Do all four, in this order:

1. OpenShift `demi-app-secrets` in `6cdc9e-prod`, key `ADMIN_API_KEY`. This is the source of truth;
   a deploy that runs before this step writes the OLD value back over the vault.
2. New version of the `admin-api-key` secret in `demi-kv-prod`. The vault has no public endpoint —
   set it from inside the VNet, or through the portal with a private-endpoint-reachable session.
3. Restart the app: `az functionapp stop` then `az functionapp start`. A `restart` does not recycle
   the worker, and App Service otherwise refreshes a reference on its own schedule (up to 24 h).
4. Every other holder of the same value — the GPU extraction box's env file at minimum. A holder
   skipped keeps presenting the old key and 401s.

Verify: `curl -H "X-Api-Key: <new>" https://demi-api-prod.azurewebsites.net/api/db/stats` → 200.
A literal `@Microsoft.KeyVault(...)` string in the live app setting means the reference did not
resolve — check the `Key Vault Secrets User` grant on `demi-identity-prod` and that the app's
`keyVaultReferenceIdentity` names that identity.

Single-key auth means a window where one of the two values is wrong for some holder. Removing it
needs dual-key acceptance on the readers — see the "Key manager / rotator" entry in
[FUTURE.md](FUTURE.md).
