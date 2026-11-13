# Search backend switch

One Mongo field decides which backend eagle-public calls for search. Which datasets move with it
depends on the eagle-public line deployed:

- `develop`, the line prod runs today: `Project`, `Document`, `DocumentChunk`.
- `react`, from `v3.0.0`: those three plus `List`, `Organization`, `RecentActivity` and
  `ProjectNotification`. Not merged into `develop`, so none of those four move on prod yet.

Neither line covers `CommentPeriod` or `Comment`: eagle-public reads those from eagle-api whatever
the field says.
eagle-api serves it from `/api/config`; the browser reads it once per page load.
`/api/config` serves the new value within 19–38 s (measured 2026-08-21); poll up to 60 s before
concluding the change did not land.

## The field

`Config.SEARCH_API_PATH` in the prod `epic` database, document `_schemaName: 'Config'`.

| Value | Meaning |
|---|---|
| `/demi-search` | Live: eagle-public calls `demi-api-fc-prod` for the datasets its line moves. |
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
- On the `develop` line prod runs today, `dataset=List` is still answered by eagle-api regardless
  of `SEARCH_API_PATH`, and so are `Organization`, `RecentActivity` and `ProjectNotification`.
  They move with the field only once prod runs `react` (`v3.0.0`).
- `dataset=CommentPeriod` and `dataset=Comment` are answered by eagle-api on both lines — those
  two are not on this switch.
- `/api/config` 200, `/admin/` 200.

## After a change

Watch for 1 h: the App Insights 5xx rate on `demi-api-fc-prod` and the `demi-search-availability-prod`
webtest. Run the ACL probe against prod explicitly (the script defaults to test):

```
DEMI_API_BASE=https://demi-api-fc-prod.azurewebsites.net ADMIN_API_KEY=<ADMIN_API_KEY from secret demi-app-secrets in 6cdc9e-prod> \
  node src/scripts/probe-acl.js
```

It writes to prod: it plants hidden/control rows, mints two short-lived API keys, exercises 26
cells, then deletes the rows and revokes the keys (the tail of its output confirms the cleanup).
Expect `26 passed, 0 failed`. Use the kill switch (`''`) if search answers 5xx or the probe fails;
the kill switch is reversed the same way.

Pulling a published record back from the public is a different procedure: `takedown-runbook.md`.

Nothing outside `/api/sealed` reads a sealed record: only that controller builds the access context
that lifts the exclusion, so a `compliance` holder on `GET /api/documents` or `/api/search` sees no
more than anyone else. Exports and backups stay locked down for the same reason plus a second one —
no seed, export or reconcile script adds the `compliance` role to its access context
(docs/rbac-architecture.md §1, condition 2). `test/controllers/nosql/sealed.test.js` fails if a
script under `src/scripts/` names the role.

## Level-0 material on the devbox

These scripts read with `systemAccess()`, the level-0 context that passes every ACL, so anything
they print or write out is unredacted and is handled as level-0 material:

`src/scripts/backfill-chunk-parent-fields.js`, `backfill-document-list-ids.js`, `backfill-eac-number.js`,
`backfill-objects.js`, `backfill-trim-project-labels.js`, `backup-originals.js`,
`build-phase-catalog.js`, `build-works-catalog.js`, `check-business-works-parity.js`,
`check-works-parity.js`, `date-assessment-phases.js`, `fold-twins.js`, `load-business-works.js`,
`purge-extraction.js`, `reconcile-eagle.js`, `restore-originals.js`, `rollback-business-works.js`,
`seed-nosql.js`, `seed-public-reads.js`, `sync-track-projects.js`, `sync-track-run.js`,
`sync-wildfires.js`, `works-crosswalk.js`.

`grep -n systemAccess src/scripts/*.js` is that list; a script added to one is added to the other.

`src/scripts/copy-to-env.js` and `src/scripts/backfill-eagle-ladder.js` are level-0 material as well
and are deliberately absent from that grep. Both query a container directly with no access
predicate, which is wider than `systemAccess()`, not narrower. `copy-to-env.js` runs `SELECT * FROM c`
over `projects`, `documents`, `boundaries` and `chunks`; `backfill-eagle-ladder.js` selects ACL
fields from every Eagle-mirrored container.

`copy-to-env.js` drops `externalIds`, `staffAssignments`, `capitalInvestments`, `staffNotes` and every
`intake` copy from `projects` rows. `--keep-staff <sign-off reference>` keeps them; the reference is one
token with no spaces, and the business gives it. It never copies the `works` container or the
`ImportBatch`, `ImportBatchEntry` and `ImportLock` items.

These scripts leave a file behind rather than only printing:

- `backup-originals.js --out` and `restore-originals.js --out`
- `seed-nosql.js` and `seed-public-reads.js`
- `backfill-chunk-parent-fields.js`, its state file
- `copy-to-env.js`, its `--checkpoint` file, written on every `--live` run
- `works-import-key.js`, the devbox key; `works-crosswalk.js`, `check-business-works-parity.js` and
  `load-business-works.js`, sealed files in `--out-dir`

### Delete the copy checkpoint

`copy-to-env.js --live` writes the `--checkpoint` path (default `./copy-checkpoint.json`) on every
run. It holds resume state per container, not chunk text, but it is still level-0 material. Delete it
off the devbox once the copy is verified complete:

```
shred -u <path passed to --checkpoint, or ./copy-checkpoint.json>
```

A devbox is stop/start operated and only `/home` survives a stop, so a file left there outlives the
session that made it.

## Business works load on test

The business works spreadsheets load into DEMI through devbox scripts. They refuse any Cosmos account but `demi-cosmos-test`, and a prod run needs Daniel's own ask.

Run each `node` and `yarn works:load|crosswalk|parity|rollback` command as `scripts/demi-devbox.sh run --env test -- '<command>'`. The `yarn works:extract` commands run on the operator's laptop.

The order of `WORKS_WRITE`, the nightly parity check and `WORKS_READ` is in the wiki page Sync-Architecture. This section starts after those are on.

### Before the first run

1. In Track, set the project form field "EPIC GUID" on projects 359, 365, 367, 373, 374 and 412 to the Eagle id the crosswalk names. A Track user with role `edit` does this. Until it is set, the Track merge writes `eagleId: null` on those rows.
2. Fold the six `eagle-<id>` twins into their Track rows. The dry run prints each changed field and `planSha256=`; a pair prints `refused=eagleIdUnset` while step 1 is undone.

   ```
   node src/scripts/fold-twins.js --pairs <trackId>:<eagleId>,…
   node src/scripts/fold-twins.js --pairs <same list> --live --expect-plan-sha256 <planSha256>
   ```

3. `node src/scripts/build-works-catalog.js` prints `missing=0`.
4. `node src/scripts/works-import-key.js` writes the devbox key and prints its public keys and fingerprint. The operator records the fingerprint.

The owner guard in `src/repositories/works.js` stops one source overwriting another's works by mistake. It is not access control for devbox scripts: any script can pass any owner name, and the devbox identity has full data-plane rights.

### Extract and crosswalk

1. The operator makes one key per environment with `yarn works:extract keygen --env test --out-dir <dir> --passphrase-ref <ref>`.
2. The test extract replaces project numbers with surrogates, and the map is sealed with a passphrase. `--surrogate-passphrase-ref` names its keyring entry: service `eagle-demi-works-import`, account `<ref>`, read with `secret-tool` on Linux or `security` on macOS. A 1Password `op://` reference also works. The passphrase has at least 20 characters and never sits in a file beside the map.
3. Extract and upload. The extract drops staff fields unless `--keep-staff-on-test <sign-off reference>` is given, and keeps real numbers only with `--keep-numbers-on-test <sign-off reference>`. It prints `plaintextSha256=`.

   ```
   yarn works:extract extract --env test --in <folder> --recipient-key <devbox public keys pem> \
     --expect-fingerprint <devbox fingerprint> --out <file>.sealed.json \
     --surrogates <map file> --surrogate-passphrase-ref <ref>
   ```

4. Seal the manual-match file with `yarn works:extract seal --purpose manual-match …` and record its SHA-256. Upload the extract and the sealed manual-match file to the `works-import` container with `--auth-mode login`.
5. Build the crosswalk on the devbox. It prints one count per state and `crosswalkCsvSha256=`, and it exits 1 unless every row is `exact` or `manual`. Expect `unmatched=0 unlinked=0 unfolded=0 ambiguous=0`.

   ```
   yarn works:crosswalk --env test --extract <sealed> --expect-extract-sha256 <hex> \
     --manual <sealed> --expect-manual-sha256 <manual-match SHA-256> --devbox-key <pem> \
     --operator-key <pub pem> --expect-operator-fingerprint <hex> --out-dir <dir>
   ```

6. `yarn works:extract open --purpose crosswalk …` writes the CSV for review. The business signs off `crosswalkCsvSha256` and gives a sign-off reference. `yarn works:extract seal --purpose crosswalk --signature <file>.sig …` seals the signed CSV back to the devbox.

### Dry run and live run

Export `WORKS_READ` and `WORKS_READ_SOURCES` with the API's values before the `--live` run. The devbox shell has no app settings, and the `--live` derive step refuses to start without both.

1. The dry run writes nothing to DEMI. It prints the plan counts, `inputSha256=`, `crosswalkSha256=`, `planSha256=`, `reportSha256=` and `blob=`.

   ```
   yarn works:load --extract <sealed> --expect-sha256 <hex> --crosswalk <sealed> --expect-crosswalk-sha256 <hex> \
     --expect-manual-sha256 <hex> --devbox-key <pem> --expect-devbox-fingerprint <hex> \
     --operator-key <pub pem> --expect-operator-fingerprint <hex> --out-dir <dir>
   ```

2. `yarn works:extract open --purpose works-report …` writes the report for review. The business signs off the four hashes.
3. `--live` is available on test. Add these options to the same command. It prints `batchId=`, `backupBlob=` and `backupSha256=` before it writes, then `written=` and `derived=`.

   ```
   --live --operator <upn> --run-ref <id> --signoff-ref <sign-off reference> --expect-plan-sha256 <planSha256>
   ```

4. Reseal the works-backup to the devbox, for a rollback. Nothing plain is written.

   ```
   yarn works:extract reseal --env test --purpose works-backup --in <backup>.sealed.json \
     --key <operator key pem> --passphrase-ref <ref> --expect-sha256 <backupSha256> \
     --recipient-key <devbox public keys pem> --expect-fingerprint <devbox fingerprint> --out <file>.sealed.json
   ```

5. `yarn works:parity` takes `--extract`, `--expect-extract-sha256`, `--crosswalk`, `--expect-manual-sha256`, `--devbox-key`, `--operator-key`, `--expect-operator-fingerprint` and `--out-dir`. It prints `mismatch=0` and exits 1 on a failing count.
6. A second dry run prints a plan with `written=0`.

### Turn the sheet source on or off

1. Set `WORKS_READ_SOURCES` to `track,sheet` on the API. The setting is in the wiki page Sync-Architecture.
2. Export the same value on the devbox, then run `yarn works:rollback --rederive <batchId>`. It probes the public project read for a sheet work of the batch and prints `flipProbe=<project id>`. It refuses when the probe finds none, then derives every project of the batch.
3. After sheet leaves `WORKS_READ_SOURCES`, run `yarn works:rollback --rederive <batchId> --unflip`. The probe must find no sheet work.
4. Run `--rederive` after any change to `WORKS_READ_SOURCES`, and again after the first publish of any batch row. The probe calls `https://demi-api-fc-test.azurewebsites.net/api/projects/<id>` with no credentials.

### When hiddenDrift is above 0

`yarn works:parity` prints `hiddenDrift=N` for projects with an active override marker. It counts Track works the load's match would hide that the marker does not pair, marker pairs the match stopped making, and `trackAlive` entries whose Track work is gone. The count does not fail the check.

1. The operator who ran the load re-runs the dry run.
2. The business signs off the new report.
3. The operator runs `--live` with the new hashes. On prod the `--live` run needs Daniel's ask.

### Roll back or adjust a load

A rollback needs the resealed works-backup. Keep it, and the devbox key that opens it, for 30 days after the load. After 30 days only `--revert-override` is left.

Every mode below except `--abandon-rollback` and `--clear-stale-lock` refuses unless `WORKS_READ` and `WORKS_READ_SOURCES` are exported with the API's values.

| Command | Effect |
|---|---|
| `yarn works:rollback --rollback <batchId> --backup <sealed> --expect-backup-sha256 <backupSha256> --devbox-key <pem> --expect-devbox-fingerprint <hex>` | Undoes the latest complete load batch. |
| `yarn works:rollback --rollback-incomplete <batchId>` | Undoes a pending load or override batch whose lease expired. A load batch also takes the four backup options above; an override batch takes none. |
| `yarn works:rollback --abandon-rollback <rollbackBatchId>` | Gives up a stuck rollback batch and prints its open steps. A fresh `--rollback` then finishes. |
| `yarn works:rollback --revert-override --project <id>` or `--all` | Turns the sheet override marker off, so Track's covered works show and the sheet's do not. `--all` is every marker the latest complete load batch wrote. |
| `yarn works:rollback --reapply-override --project <id>` or `--all` | Turns the marker back on. |
| `yarn works:rollback --rederive <batchId> [--unflip]` | Derives the batch's projects again. See "Turn the sheet source on or off". |
| `yarn works:rollback --clear-stale-lock` | Deletes an expired import lock a stopped run left, when its batch is not pending. |

A failed run leaves its rollback batch pending, and the same command resumes it. A failed revert or reapply leaves its override batch pending; clear it with `--rollback-incomplete <id>`.

After a `WORKS_READ` rollback, the first nightly run writes Track's works back onto the project rows as drift. It leaves `updatedAt` alone.

### Check the staff works route

On test, call `GET /demi/api/projects/<id>/works-staff` through the Front Door host with a staff token. It answers 200, and a call with no token is refused. A 404 from the edge means the path is missing from `demiApiReadPrefixes` in `digitalspace/eagle-edge`.

The response shape is in `src/swagger/swagger.yaml`.

### Clean up and check that the files are gone

After the load is verified, delete these:

- the blobs in `works-import` (a 7-day delete rule is the backstop);
- the operator private key for the environment;
- the review folder on the laptop and every decrypted copy;
- the share copy and both recycle-bin stages.

When the 30 days end, also delete the works-backup and the devbox key in `/home/demi/works-import/`.

The share step for the business:

1. Put the opened files in the internal document library the operator names in the activity-log entry. Limit it to the named reviewers and turn sync off for that library.
2. After sign-off, delete the copy and empty both recycle-bin stages. Or skip the share and review in a viewing session from the laptop folder.
3. Record the library's name and its retention setting in the activity-log entry, with the sign-off reference.

The "files gone" check, after cleanup:

- `az storage blob list --container-name works-import --account-name <API storage account> --auth-mode login --query "length(@)"` prints 0.
- `scripts/demi-devbox.sh run --env test -- 'find /home/demi/works-import -type f -mtime +30'` prints nothing. Within the 30 days the folder holds only the backup, the reports and the devbox key.
- The laptop review folder and the share, including its recycle bin, are empty.

`ImportBatch` and `ImportBatchEntry` items stay. They hold ids and hashes only.

## Rotating ADMIN_API_KEY

Owner: Daniel Truong — the only holder of a prod write login, and the only person who can run
`CONFIRM_PROD=yes ./scripts/deploy-infra.sh prod --live`. That command deploys the application
layer, which is all a rotation needs; `--foundation` deploys everything and is only required after
a change to one of the foundation modules listed in the README.

`ADMIN_API_KEY` is a Key Vault reference on the app, not a stored value. The app setting
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

Verify: `curl -H "X-Api-Key: <new>" https://demi-api-fc-prod.azurewebsites.net/api/db/stats` → 200.
A literal `@Microsoft.KeyVault(...)` string in the live app setting means the reference did not
resolve — check the `Key Vault Secrets User` grant on `demi-identity-prod` and that the app's
`keyVaultReferenceIdentity` names that identity. The app reads that string as no value at all
(`src/config.js`) and logs the setting name, so break-glass is closed rather than accepting a
reference anyone who can read the app settings could present.

Single-key auth means a window where one of the two values is wrong for some holder. Removing it
needs dual-key acceptance on the readers — see the "Key manager / rotator" entry in
[FUTURE.md](FUTURE.md).
