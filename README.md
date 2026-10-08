# eagle-demi

DEMI (Document Extraction & Machine Intelligence) for EPIC, on Azure.

This repository houses:

1. **demi-api** — the authoritative REST API and geospatial search service for projects, documents,
   chunks and administrative boundaries, running on Azure Functions Flex Consumption
   (`@azure/functions` v4 on Node.js 22).
2. **demi-frontend** — the React search frontend, published to the `$web`
   container of a Storage static website and served through the Front Door profile that lives in
   `eagle-search`.

> **Status: live in staging and prod.** Staging (`c4b0a8-test`, resources `demi-*-test`) redeploys
> on every push to `main`. Dev is an empty sandbox shell (redeploy from Bicep on demand; the dev
> estate was torn down 2026-08-11). Prod (`c4b0a8-prod`, resources `demi-*-prod`) deploys from a
> tag verified on staging and has served EPIC's search since 2026-08-26.
>
> This file covers what you need at the keyboard. Architecture, measured facts, Azure environment
> detail and the traps live in the [wiki](https://github.com/digitalspace/eagle-demi/wiki) — start at
> [Environment Reality & Operational Gotchas](https://github.com/digitalspace/eagle-demi/wiki/Environment-Reality-and-Operational-Gotchas).

---

## Local development

```bash
yarn install
yarn start            # Azure Functions Core Tools (`func start`) on :7071
```

OpenAPI spec: `http://localhost:7071/api-docs` — the raw YAML, not a UI. Not served in prod.

### Running anything against the database

Cosmos sits behind a private endpoint **and is keyless**, so database scripts cannot run from a
laptop. The Flex app has no Kudu or SCM site to run them in either, and with local auth disabled
there is no key to fall back on. Opening the firewall is denied by Azure Policy.

`demi-devbox-test` is where they run: a small VM inside the landing-zone VNet, running as
`demi-identity-test` — the same identity the API runs as, so a script there has exactly the app's
Cosmos, Key Vault and Search access and nothing more. It is deallocated between sessions, and a
schedule shuts it down at 19:00 Pacific.

**Scripts go over the ARM control plane** — no network path from here, no SSH:

```bash
scripts/demi-devbox.sh run --env test -- 'node src/scripts/reconcile-eagle.js'
az vm deallocate -g c4b0a8-test-rg -n demi-devbox-test   # after; compute bills for every hour it runs
```

`run` starts the VM if it is stopped or deallocated, then waits until the VM agent is `Ready` and
no extension or handler is transitioning (up to 20 minutes, `DEVBOX_READY_TIMEOUT`; on timeout it
names what is busy). Failed and `NotReady` extensions are listed and not waited on. It then runs
the command in `/opt/eagle-demi` as `sudo -u demi /usr/local/bin/demi-run '<command>'`, prints
its output and exits with the command's exit code. One argument after `--` is a shell command
line; several are passed as separate arguments. The script needs `az` on your machine, and `jq` unless `DEVBOX_RUNNER` is set.

`demi-run` is the whole interface. It logs the CLI in as the managed identity, exports
`AZURE_CLIENT_ID`, `COSMOS_ENDPOINT`, `COSMOS_NOSQL_DATABASE`, `SEARCH_ENDPOINT` and
`EAGLE_API_BASE`, then runs what you gave it. `sudo -u demi` because run-command runs as root and
both the `az` login and the checkout belong to `demi`.

**It runs the command rather than printing an environment to `eval`, deliberately.** Under
`eval "$(prime-the-env)" && node script.js` the shell cannot see the login fail — command
substitution drops the exit status — so the script runs with nothing set, and the scripts degrade
rather than fail: an unset `COSMOS_ENDPOINT` makes `getContainer` warn and return null, and an unset
`SEARCH_ENDPOINT` makes `deleteFromIndex` return 0 instead of throwing. A purge that way exits 0
having done nothing, which reads exactly like "already clean". `demi-run` is `set -euo pipefail`, so
a failed login fails the run-command visibly.

Four things to know:

1. **By default output is cut at 4 KB and a run stops at 90 minutes.** That is
   `az vm run-command invoke`, which the script uses unless `DEVBOX_RUN_MODE=managed`. Managed mode
   runs a managed run command instead: the VM writes stdout and stderr to append blobs in container
   `devbox-run-output` on the `demifc*` account (`DEVBOX_OUTPUT_ACCOUNT` to override), so there is
   no output cap, and the script timeout is `DEVBOX_RUN_TIMEOUT` (default 4 hours for `run`, 90
   minutes under a search role grant). The blobs are written through a user-delegation SAS minted
   from your `az` login, which carries only your own blob roles, so **managed mode needs Storage
   Blob Data Contributor on that container**, plus the delegator role below; with Reader the run
   fails with `403 AuthorizationPermissionMismatch`. After every managed run, including one that timed out,
   was interrupted or failed at create, the script asks Azure to delete the run-command resource (a
   VM holds at most 25) and deletes the blobs it finds. A timed-out or interrupted script may still
   be running and can write the blobs again until its SAS expires; the script prints that expiry.
   If the output download itself fails, the blobs are kept and the script prints their path.

   In deployed environments the container comes from `azure/modules/api-function-flex.bicep`; the
   script still creates it if it is missing. The roles are granted by hand to each person who runs
   managed mode:

   - Storage Blob Data Contributor, scoped to the container, to write and read the run's blobs.
   - Storage Blob Delegator, scoped to the storage account, to get the user delegation key that
     signs the SAS. Azure checks that key at account scope or above, so the container role does not
     cover it. Not needed for someone who already has Owner or Contributor over the account.

   Grant each with `az role assignment create --assignee <object-id> --role "<role>" --scope <scope>`.
   The account scope is its full resource ID, from `az storage account show -n <account> --query id
   -o tsv`; the container scope is that ID plus `/blobServices/default/containers/devbox-run-output`.
   Neither grant is in Bicep: no param file holds a person's object id, and the Data Contributor
   grants that exist today were made by hand, so a template grant for the same person would fail
   with `RoleAssignmentExists`.

2. **`/opt/eagle-demi` is a shallow clone made at first boot**, not a deploy. `git pull && yarn
   install` in the same run-command before anything that depends on a recent change.
3. **The VM is a `Standard_B2s` — 4 GiB of RAM.** A big export needs `node
   --max-old-space-size=...`; Node's default heap gets the process OOM-killed with no error, it
   simply vanishes.
4. **A run still going at 19:00 Pacific dies with the auto-shutdown.** Disable the schedule for the
   day, or start the run earlier.

**Interactive work is Bastion**: `bastion-test` is the Developer SKU, which is the portal's browser
shell and only that — no native client, no tunnel, no `scp` (those need Standard). Portal → the VM →
Connect → Bastion, then `demi-run bash` in the shell it gives you.

Search *admin* operations run on the VM too — the search service is private-endpoint only, so a
laptop cannot reach its data plane either. What is unchanged is the grant:
`scripts/with-search-admin.sh` gives the identity Search Service Contributor for the length of one
command and revokes it afterwards, and it wraps the same `demi-run` call as anything else.

**After any deploy that touches `azure/search/` or search code, run the drift check.** It reads the
live index schema and reports any committed field the live index does not have — the class of bug
that reached prod once already, undetected. Read-only, exit 1 on drift:

```bash
scripts/demi-devbox.sh drift --env test      # or --env prod
# what it runs, if you would rather do it by hand:
scripts/with-search-admin.sh -- \
  az vm run-command invoke -g c4b0a8-test-rg -n demi-devbox-test --command-id RunShellScript \
  --scripts "sudo -u demi /usr/local/bin/demi-run 'cd /opt/eagle-demi && node src/scripts/apply-search-definitions.js --check'"
```

`scripts/demi-devbox.sh apply --env <env> [--only documents]` is the repair: it dry-runs, prints
what it would write, asks, and then does the three writes in the order that keeps the site up —
index, data source, indexer reset and run. It reads the resource group, the tenant and the indexer
identity off the resources themselves, so a prod run cannot inherit the test defaults. Outage
symptoms and the rest of the response: `docs/runbook-search-outage.md`.

Each phase is one run command, and every one is a 20-45 s round trip through ARM.
That is why a drift check is a single call and an apply is three or four, whatever `--only` names:
the per-index steps loop inside one payload, and the wait for the indexer runs on the devbox
(`src/scripts/reset-and-run-indexers.js`) rather than as a call per poll.

`chunks-indexer` takes hours, the wait gives up after 80 minutes and a run stops at 90, so reset it with
`--no-wait`: the script posts the reset and the run, releases the role grant, and prints the
`watch` command to pick the wait back up later.

```bash
scripts/demi-devbox.sh apply --env prod --only chunks --datasources demi-chunks-ds --no-wait
scripts/demi-devbox.sh watch --env prod --datasources demi-chunks-ds
```

### Applying definitions through the API

`POST /api/admin/search-definitions/apply` runs the same apply inside the Function app, which is
the primary path. Nothing goes through ARM, so a run costs what the search service costs and
nothing more. `sysadmin` only, and the work runs on a queue: the answer is 202 with a job id and
`GET /api/admin/search-definitions/jobs/{id}` is the poll.

```bash
curl -sS -X POST "$DEMI_API/admin/search-definitions/apply" \
  -H "X-Api-Key: $DEMI_KEY" -H 'content-type: application/json' \
  -d '{"only":["projects"],"datasources":["demi-projects-ds"],"live":true}'
```

`check: true` reports drift and writes nothing; neither flag is a dry run; `live: true` PUTs and
then resets and runs the indexers it touched. The wait stops at 25 minutes — short of the host's
30-minute function timeout — and a job whose indexer is still running finishes `warned` with the
indexer named, which for `chunks` is the normal outcome. The rebuild carries on either way.

The identity still needs Search Service Contributor at the service scope for the duration of the
run; `scripts/with-search-admin.sh` is what grants and revokes it. `SEARCH_DEFINITIONS_QUEUE`,
`DS_SUB`, `DS_RG` and `DS_IDENTITY_ID` come from `azure/main.bicep` — no queue name and the route
answers 503, and the devbox recipe above is the way through.

`scripts/with-search-admin.sh apply --env <env>` does the grant, the POST, the poll and the revoke
in one command:

```bash
ADMIN_API_KEY=... scripts/with-search-admin.sh apply --env test --only projects \
  --datasources demi-projects-ds --live
```

`ADMIN_API_KEY` is the env var name, not the break-glass key. Mint one for the run instead — a
registry key whose only role is `sysadmin`, which is all this route needs:

```bash
curl -sS -X POST "$DEMI_API/admin/api-keys" -H "X-Api-Key: $DEMI_KEY" \
  -H 'content-type: application/json' \
  -d '{"name":"search-definitions <who> <date>","roles":["sysadmin"],"allowWrite":true}'
```

The plaintext comes back once and nowhere else. Export it as `ADMIN_API_KEY`, run the apply, then
`DELETE /admin/api-keys/<keyId>`. A key per run is one that can be revoked the moment the run is
over and that names who ran it in the audit record; the break-glass key out of Key Vault is
neither, and every copy of it taken for a routine apply is another place it can leak from. Only a
caller that already holds `sysadmin` can mint one.

It calls `https://demi-apim-<env>.azure-api.net/machine/admin/search-definitions/apply`. The
`/machine` product takes the route without the `/api` prefix, because the APIM backend already
carries it. `queued` and `running` are polled through; `succeeded` and `warned` exit 0, `failed`
and anything else exit 1, and a revoke that fails exits 3 — the grant is still standing and the
message says how to delete it. A `warned` run prints the per-indexer results and the warning — for
`chunks` that is the usual end, and the rebuild carries on after the role is revoked.

A run is refused with 409 while another is `queued` or `running`, and `live` needs an explicit
`--only`: an empty one means every definition, which resets every indexer including `chunks`.

```bash
npm run db:seed-nosql            # dry run by default; --live to write
npm run db:seed-nosql -- --only projects --live   # projects only
npm run db:seed-nosql -- --reconcile   # also delete rows the fetch did not produce
npm run db:seed-public-reads     # lists, notifications, updates, comment periods, comments
npm run db:purge-extraction      # dry run by default; --live to write
```

A re-seed **carries extraction state forward**. A Cosmos upsert replaces the item, so the seeder
reads `contentExtracted`, `contentExtractedAt`, `contentPageCount` and `contentExtractionError` out
of each partition before writing it and puts them back on any document it already holds; new ids
start unextracted. The run reports `preserved`.

The projects stage **resolves the Eagle slot into the same shape the push sends**. eagle-api pushes
`proponentId`, `proponentName`, `pins` as `[{_id, name, province}]`, `applicableRegulation` and
`featuredDocuments` on every project write, but nothing re-pushes rows that were seeded before that
existed — 396 rows in demi-test held `proponentId: null`. `/api/public/search?dataset=Project`
returns `proponent` populated and `pins` as bare ObjectIds instead, so the seed fetches the
Organization list once and `src/merge/project.js` normalises both, on the seed path and the push
path alike. Re-running the projects stage against an existing database is the way to fill those
fields; it keeps `vis`, the short-link fields (`shortCode`, `shortCodeSource`,
`legacyShortCodes`), the Track source block, and the two fields the search does not carry at all
(`applicableRegulation`, `featuredDocuments`).

`--reconcile` (off by default) is the other half: rows that exist in Cosmos but not in the fetch are
deleted through the same helpers `DELETE /documents/:id` and `DELETE /projects/:id` use, so the
chunks and the search-index entries go with them, and each deleted row emits the same
`document.delete` / `project.delete` audit event those routes do. A dry run reports `wouldDelete`
per container and deletes nothing. Deletion is a single phase after every fetch has finished —
documents before projects — so a refusal stops it **before any delete**, in both containers at once.
It refuses — exit 1, nothing removed — if `--only` dropped a stage, if `--limit-documents` was
given, if the Project, ProjectNotification or Document fetch was not verified complete against
eagle-api's `searchResultsTotal`, if a document that resolved to neither a project nor a
ProjectNotification is already in Cosmos (a drop the fetch cannot account for is only at risk when
there is a row to delete; drops absent from Cosmos are reported as `droppedUnresolvable` and do not
refuse), if either container enumerated fewer rows than a `COUNT` of the same predicate reports (a
truncated read is indistinguishable from a container that shrank), or if there is no
`COSMOS_ENDPOINT` to enumerate the containers with: every one of those makes the untouched remainder
look like surplus. A live run also refuses when `SEARCH_ENDPOINT` is unset, for the opposite reason —
the deletes would land in Cosmos and silently no-op against the index, leaving the purged rows
searchable. A dry run reports that as `search: unconfigured — live would refuse` instead.

Every surplus id goes to an NDJSON file — one `{label, id, partitionKey, deleted}` row per surplus
row, both containers, dry run and live — and the run prints the path. It defaults to
`/home/reconcile-<timestamp>.ndjson`, or the working directory where `/home` does not exist;
`RECONCILE_LOG` overrides it. The console line stays capped at the first 20 ids.

There is also a ceiling on how much one reconcile may delete, because a fetch verified only against
itself is not enough — an eagle-api answering `searchResults: [], searchResultsTotal: 0` is
internally consistent and would make the entire corpus surplus. Each container refuses when its
surplus exceeds `max(50, 2% of the rows in it)`; the refusal names the ceiling and the surplus, and
stops **both** containers before any delete, in a dry run too. `--max-surplus <n>` raises the
ceiling to `n` for the run — the operator asserting the loss really is that big. It requires
`--reconcile` and a positive integer.

### Reconcile

```bash
node src/scripts/reconcile-eagle.js            # --json for the full id sets
node src/scripts/reconcile-eagle.js --comments # and sweep the comments container
node src/scripts/reconcile-eagle.js --store    # and save the class report for GET /api/admin/reconcile
```

The drift check for the Eagle push, without a re-seed: DEMI rows gone from Eagle's public search
(a hard delete carries no tombstone) and Eagle ids the push never landed. **It reports and changes
nothing.** `unpublishedOrDeleted` is not a delete list: eagle-api answers `200 []` on
`/api/public/{document,project}/{id}` both for a deleted row and for one that merely lost `public`
from its `read[]`, so an anonymous caller cannot tell the two apart, and purging on that set would
destroy an unpublished row along with its chunks and index entries. A purge needs a probe that
separates them — a tombstone, or a credential that reads unpublished rows. A document whose own
project is unpublished/gone is not counted as `eagleOnly` drift either — seed-nosql drops it the
same way — it reports separately as `unresolvedParent`.

For an id both sides hold, `aclMismatch` lists rows whose DEMI `read[]` lets in different callers
than the `read[]` the mirror would write from Eagle's, or whose `isPublished` no longer matches
its own `read[]`. A document, comment period or comment is first narrowed to its DEMI parent's
ACL, the same way the mirrors do, so a row under a private project is not reported. The two ACLs
are compared by access level, not by exact spelling: the early seed stored Eagle role names such
as `['public','sysadmin','staff']`, and the mirror now writes ladder tokens such as
`['staff','idir','public']` for the same level. Two reads at level 4 always match. At levels 2
and 3 they match when they hold the same names once privileged ones (`sysadmin`, `demi-admin`,
the `demi-service-*` roles) are set aside, since those callers read every row anyway. At level 1
the sets must be equal, because `['team']`, `['sysadmin']` and `[]` are all level 1 but let in
different callers. These count toward `drift=`. A row whose Eagle `read` is empty or missing is
not compared, including a legacy Update with a missing `read` that takes its parent's read
(`docs/public-read-backfill.md`). This script does not rewrite them, and nothing writes back to
Eagle. Do not repair them with a full document re-push: it replaces whole rows and undoes
DEMI-side changes.

One line is what a log alert matches:

```
[reconcile] projects: unpublishedOrDeleted=0 eagleOnly=0 aclMismatch=0 documents: unpublishedOrDeleted=0 eagleOnly=0 unresolvedParent=0 aclMismatch=0 commentPeriods: unpublishedOrDeleted=0 eagleOnly=0 aclMismatch=0 lists: unpublishedOrDeleted=0 eagleOnly=0 aclMismatch=0 notifications: unpublishedOrDeleted=0 eagleOnly=0 aclMismatch=0 updates: unpublishedOrDeleted=0 eagleOnly=0 aclMismatch=0 comments: skipped engageOrphans: skipped parentFieldsPending=0 drift=0
```

It covers the containers the Eagle push and the backfill write. Comments are behind `--comments`
because the sweep costs one eagle-api request per comment period, which is too much for the nightly
timer; a container the run did not sweep says `skipped` rather than reporting zero drift. The
backfill itself is `docs/public-read-backfill.md`.

Set `RECONCILE_SCHEDULE` to an NCRONTAB expression (six fields, seconds first) and the API app
registers a Functions timer that runs the same check nightly and logs that line. **Prod only**
(`0 0 10 * * *`): the test corpus was seeded from prod Eagle while test's `EAGLE_API_BASE` is
eagle-test, so a nightly diff there would report the gap between two unrelated corpora — run it by
hand in test with `EAGLE_API_BASE` overridden instead. Unset, no timer is registered at all. The
alert `demi-reconcile-drift-prod` reads the line out of `AppTraces` hourly and mails the DEMI action
group whenever `drift=` is over 0; a night the job never runs writes no line and raises nothing.

A second line, `[reconcile] classes ...`, counts each drifted id under the class that most likely
explains it, using `classify` from `src/scripts/parity-map.js`. For example, a missing child whose
parent DEMI holds is `push-missed-parent-in-demi`, and one whose parent ref is empty or names a row
in neither Eagle, DEMI nor Track is `orphan-parent-missing-in-eagle`. The alert does not read this
line. With `--store`, which the timer passes, the run also saves the counts and up to 200 ids per
class as one row in the `config` container, read back with `GET /api/admin/reconcile`. A failed
save is logged and the run still finishes. Nothing is fixed automatically.

### Parity with eagle-api

```bash
node src/scripts/parity-eagle.js --eagle https://<eagle host>/api --demi https://<demi host>/api \
  --identity staff --token-env PARITY_TOKEN --id project=<eagleId> --id period=<eagleId> \
  --known-ids known.json --report parity.json
```

Checks that a consumer of eagle-api would see the same rows and fields from DEMI. Each read in
`src/scripts/parity-map.js` is sent to both APIs with the same identity (`anonymous`, the default,
or `staff`/`sysadmin` with a bearer token read from the variable `--token-env` names; a token is
never taken on the command line). Rows pair on Eagle `_id` against DEMI `eagleId` or `id`. `--id`
takes `project`, `period`, `document`, `comment`, `organization`, `inspection`, `element` and
`group`; `--help` lists them.

The two CSV reads, `comment-export` and `report-bcgw`, compare the header row, then rows paired on
one column (`Comment_No`, `Project GUID`) across every column both files have. `Export_Date` is
skipped. `group-members` pairs Eagle's member User rows with the member ids of DEMI's group; the
DEMI read sends no `project`, since DEMI takes that value as the Track id partition key.
`inspection-item` pairs the item ids on Eagle's element row with DEMI's items of that element, each
item carrying its element's `read[]`; it never calls Eagle's item route, which streams the file and
records a download.

eagle-api's project, document, comment period, organization, comment and project notification
routes return only `_id` and `read` unless `fields` names the rest, so each of those reads sends
`fields=a|b|c`: the fields it compares for the identity, plus `project` on comment periods and
documents. The
organization and comment period routes answer only the fields on their controller's
`ALLOWED_FIELDS`, so those reads compare nothing else (no address fields or staff dates, no `commentIdCount`);
`dataset=Organization` and `dataset=CommentPeriod` search still compare them. Pins, comments and
the staff project list come back as `[{ total_items, results }]`; each page is unwrapped to its
`results`. `recent-activity-top`
compares Eagle's newest four with `dataset=RecentActivity&top=true&pageSize=4`.

It only sends GET, at most two requests a second per API, and retries once on 429 or 5xx. It never
calls Eagle's public download route, which counts hits. Keyword searches still send Eagle analytics
events, and Eagle records a `Get` action for each `group-members` read.

One line per read:

```
[parity] search-Project identity=staff match=410 missingInDemi=3 extraInDemi=12 fieldDiff=0 unexplained=0 known=L2-never-mirrored:3,demi-only:12
```

Every difference is matched against `KNOWN_DIFFERENCES` in `parity-map.js`; what no class explains
counts as `unexplained`. Classes that match by id read their ids from `--known-ids`, a JSON object
of class name to id list; the flag may repeat, and lists of one class merge. Those classes are rows
never mirrored, DEMI takedowns and Eagle hard deletes, plus two that only explain a row extra in
DEMI:

- `seeded-from-prod`: a row from the 2026-08-25 prod seed that Eagle test does not hold.
- `ladder-above-public` (staff runs only): an Eagle row whose `read[]` has `public` but not
  `staff`, or a comment period or document under such a project. Eagle matches `read[]` tokens to
  roles literally, so its staff routes hide these rows. DEMI ranks staff above public by design, so
  DEMI staff sees them.

`--emit-ids <file>` writes ids only, never values: `extraInDemi`, each read's extra DEMI ids, and on
a sysadmin run `ladder-above-public`, the Eagle ids that rule covers. A
child counts under `ladder-above-public` only when the same run read its project. The file is a valid
`--known-ids` file (`extraInDemi` is skipped), so a sysadmin run's file feeds the staff run:

```bash
node src/scripts/parity-eagle.js ... --identity sysadmin --token-env ADMIN_TOKEN --emit-ids sysadmin-ids.json
node src/scripts/parity-eagle.js ... --identity staff --token-env STAFF_TOKEN \
  --known-ids known.json --known-ids sysadmin-ids.json
```

Build the `seeded-from-prod` list from `extraInDemi` ids checked against the prod seed.

The run exits 1
when any read has `unexplained` over 0 or fails, 0 otherwise. Reads with no DEMI target yet print
`skipped (pending)`; reads that need an id print `skipped: needs --id ...`. `--only <read>` runs
one read; `--max-pages <n>` caps paging, and a capped read compares fields only, since missing and
extra rows cannot be told from a partial slice. The `--report` file lists ids and field names of
unexplained differences, never values.

Values are compared after trimming strings; an empty string, an empty list and an absent field all count as null.
Comment period `isVetted` counts the strings `'true'` and `'false'` as booleans, and `commentIdCount`
counts null as 0. Comment period `userCan` is not compared: Eagle computes it for each caller.
These classes explain differences that come from how DEMI builds its rows:

- `track-mastered`: a project field DEMI takes from Track (`TRACK_PRECEDENCE` in
  `src/merge/project.js`: name, type, location, description and the rest) differs, DEMI's value is
  not empty, and the DEMI row has a `trackProjectId`. In the BCGW file it covers `Project name`,
  `Proponent`, `Type`, `Description`, `Latitude` and `Longitude`; in the comment export, `Project`
  (Eagle writes the raw project name, blank on legislation-keyed projects).
- `schema-default-false`: project `substantially` or `hasMetCommentPeriods`, or comment period
  `isVetted`, is `false` on one side and absent or empty on the other.
- `list-id-other-env`: a `List` row is missing or extra, and the other side has an unpaired row
  with the same name, type and legislation under another id.
- `parent-not-public`: an anonymous comment period is missing in DEMI and its project is not in
  Eagle's public project list. The list is read once per run; a `--max-pages` cut turns the class
  off.
- `display-name-from-file-name`: a document's Eagle `displayName` is empty and DEMI's equals the
  Eagle `documentFileName`, the fallback the seed writes (`src/seed/transform.js`).
- `orphan-parent-missing-in-eagle`: on staff and sysadmin runs, a comment period is missing in DEMI
  and its `project` ref is empty, malformed, or in none of Eagle's `/project` and
  `/projectNotification` lists and DEMI's `Project` and `ProjectNotification` searches. The lists
  are read once per run; a `--max-pages` cut turns the list check off.

Two DEMI limits affect anonymous runs. Anonymous `pageSize` is capped at 100, the page size this
script sends. `dataset=Organization` ignores `and[_id]` for now, so `organization-public` and
`organization` get the whole list from DEMI and count every other organization as extra.

`--download-sample <n>` (default 0, off; needs a staff or sysadmin token) also downloads up to `n`
documents both sides returned to that identity's reads in this run, through Eagle's protected
`/document/{id}/download` and DEMI's `/documents/:id/download`. It follows DEMI's redirect to
object storage without the bearer token, and compares sha256 and byte length while streaming;
nothing is written to disk. Any mismatch counts as unexplained.

`GET /search` serves eagle-api's staff datasets `User`, `Group`, `Inspection`, `InspectionElement`
and `Item` (`_id` plus `_schemaName`), and adds `InspectionItem`. Each reads under the caller's ACL,
so Eagle's default `['sysadmin']` rows reach staff and sysadmin only, and user contact fields stay
staff-only. A level-2 caller also gets the twenty staff project fields on `dataset=Project`. Every
answer with a measured total sets `x-total-count`, and `HEAD` returns the same headers. Known gaps:

- `GET /commentperiod/:id/summary` has no DEMI route. Its counts are four requests:
  `dataset=Comment&and[period]=<id>&and[eaoStatus]=<state>&pageSize=1`, reading `x-total-count`.
- `dataset=Item` answers the models above plus `Comment`, `CommentPeriod`, `ProjectNotification` and
  `RecentActivity`. `Project`, `Document` and the rest are a 400.
- The User, Group and inspection datasets order by id only. A `sortBy` is reported in
  `meta[0].dropped.sort`. They have no text index, so `keywords` is a 400.

There is no search sync command. Azure AI Search indexers pull from Cosmos every five minutes on a
`_ts` high-water mark, so nothing has to be pushed to keep the index current. Deletes are the
exception — the high-water mark cannot see them, so the application removes index entries explicitly.

### Track team sync

Set `SYNC_TEAMS_SCHEDULE` to an NCRONTAB expression (six fields, seconds first) and the API app
registers a nightly `syncTrackTeams` timer; unset, no timer is registered. It reads
`GET /api/v1/projects/team-members` from Track (`TRACK_API_BASE`, client-credentials
`TRACK_CLIENT_ID`/`TRACK_CLIENT_SECRET`) and reconciles `project:<id>` realm roles in Keycloak as
client `KEYCLOAK_ADMIN_CLIENT_ID`/`_SECRET` — only roles for projects Track lists are touched, every
other role is left alone.

The same run reads `GET /api/v1/projects` and closes out Selected Credentials over the projects
Track reports closed, writing to the `credentials` container: a grant that names other projects as
well loses only the closed id, and a grant left with no project is revoked. The listing is read once
per run and matched to the closed set in memory, plus one further read per credential actually
narrowed or revoked, so the cost does not grow with the number of closed projects that have no live
grant. `--live` refuses until the P3-2 team-grant model lands. CLI:
`yarn rbac:sync-teams` (dry run) / `-- --live`. One summary log line: `[track-teams] mode=… …`.

### Update notifications

When an Update is published, the API tells eagle-notify, which emails subscribers. It sends nothing
until both `NOTIFY_API_BASE` and `NOTIFY_API_KEY` are set.

The email links to `LINK_BASE_URL` plus a path. By default the path is the project page
(`/p/<projectId>/project-details`), or `/news` for an update with no project. Set
`NOTIFY_UPDATE_READER_LINKS=true` (Bicep param `notifyUpdateReaderLinks`) to link the update's own
page, `/updates/<id>`, instead. Only the React line of eagle-public has that page. Keep the flag off
while `LINK_BASE_URL` serves the Angular site, which is the case in test and prod today.

### Eagle read ladder backfill

`src/scripts/backfill-eagle-ladder.js` fixes the `read[]` of rows mirrored from Eagle. It is a dry
run by default and prints counts per container. `--live` writes. Run it on the devbox:

```bash
scripts/demi-devbox.sh run --env test -- 'git pull && yarn install && node src/scripts/backfill-eagle-ladder.js --reverse'
scripts/demi-devbox.sh run --env test -- 'git pull && yarn install && node src/scripts/backfill-eagle-ladder.js --reverse --live'
```

Without `--reverse` it gives each Eagle document that has no `ownRead` its stored `read`. The
project cascade re-derives a document's read from `ownRead`. Run it once on a new environment.

`--reverse` undoes a rule dropped on 2026-10-08. From 2026-10-05 the mirrors added `staff` to an
Eagle read with no ladder token (`team`, `staff`, `idir`, `public`). DEMI now stores Eagle's own
read, minus blanks and `compliance`, capped by the parent's read through `capRead`. A read with no
ladder token under a cap keeps only its privileged names and the names the cap also carries; it no
longer lands at `team`.

Two checks go with a `--live` run:

1. Before it, confirm the API runs a build that contains #549, which dropped the rule. `GET
   /api/config` returns `BUILD_ID`, stamped into the deploy package as `git describe --tags` of the
   deployed commit plus a time. Take the commit from its `g<sha>` part and check that
   `git merge-base --is-ancestor 9fc2e5c <sha>` succeeds. On an older build the next push, merge
   or cascade adds `staff` back.
2. After it, run the dry run again. It must plan 0 rows. If it plans any, a push added `staff`
   back in between. The nightly reconcile alert also reports those rows as drift.

The script works parents first: projects and notifications, then lists, users, comment periods,
documents, groups, inspections, comments and Updates. Inspections are written kind by kind:
inspection, element, item. Each child is capped by its parent's read after the reverse. A parent
whose write fails or gets a 412 keeps capping its children at its stored read. Parent containers
and Updates are read in full; the rest only where `read` carries `staff` or `team`.

A row is rewritten only when its stored `read` is exactly what the old rule gives for the same
Eagle read and parent. The script keeps a frozen copy of that rule: the staff widening plus the old
`capRead`, which stored `['team']` where the current one keeps privileged names. Every patch
carries the row's etag. The counters per container are:

- `planned` and `patched`: rows the run rewrites, and rows it did rewrite.
- `skippedHeld`: a document with `levelHeldAt`, or a row DEMI sealed. Left as stored.
- `skippedDiffers`: the stored read is neither Eagle's nor the dropped rule's, for example after a
  DEMI narrow. Left as stored.
- `noParent`: the parent row is not in DEMI. Left as stored.
- `parentMissing`: a document whose project is not in DEMI. A seed stores such a document at Eagle's
  read with no parent cap, so the script treats it as having no parent; every other child kind is
  only stored under its parent, so it counts under `noParent` instead.
- `stale`: the row changed after the scan (412). Run again.
- `failed`: the write was refused. The script exits 1.

A second `--live` run plans nothing. An Update pushed while the rule was live also stored the added
`staff` in `sources.eagle.read`, so the script cannot tell it from Eagle's own read. Those Updates
come right on their next push from Eagle.

---

## Tests

Run both halves. This is the gate for every change.

```bash
npm test
cd frontend && yarn lint && yarn test && yarn build
```

Authorization is the highest-consequence surface, so those tests assert behaviour rather than
implementation:

- anonymous sees only `public` items; a `read: ['sysadmin']` document is invisible
- `sysadmin` sees everything, including unpublished
- a scoped caller sees items in its projects only, and a project outside scope is unreachable by id
  as well as by list
- a scoped caller that is ALSO privileged is narrowed by its scope — privilege lifts the role
  predicate, never the project one
- a staff-only boundary is withheld from anonymous and returned to staff
- counts use the identical `WHERE` fragment as the read
- zero rows come back without a `read[]`

---

## Architecture

| | |
|---|---|
| API | `demi-api-fc-test` — Functions **Flex Consumption** (FC1) on plan `demi-plan-fc-test`, scale 0-20 instances, 2048 MB each. Manage with `az functionapp` |
| Database | **Azure Cosmos DB for NoSQL** (`@azure/cosmos`), account `demi-cosmos-test` |
| Search | **Azure AI Search** `demi-search-test` — Basic, keyless, private endpoint only. Live indexes `chunks`, `projects`, `documents` since the cutover on 2026-08-22. The retired `demi-*` indexes are still present and still indexing — they are the rollback target (`azure/search/README.md`) |
| Object store | `nrs.objectstore.gov.bc.ca`, bucket `zdspnb`, no key prefix (S3-compatible, `minio` client). Same bucket eagle-api TEST writes to |
| Frontend | React (Vite), built to `frontend/dist`, published to the `$web` container of the `demiweb…` storage account (`azure/modules/static-site.bicep`) and served through the Front Door profile in `eagle-search` |
| Edge | Azure Front Door Standard, profile `eagle-edge-<env>` — **owned by `eagle-search`**, not by this repo. It supplies TLS, the security headers and the SPA fallback rewrite that `$web` cannot |
| IaC | Bicep — `azure/main.bicep`, `azure/modules/` |

**The database is keyless.** The account sets `disableLocalAuth`, so there is no connection key: auth
is Entra managed identity via `AZURE_CLIENT_ID` and `COSMOS_ENDPOINT`.

**One data layer.** The MongoDB-API client and everything behind it — `src/db/cosmos.js`,
`src/models/*`, `src/helpers/access.js`, the legacy controllers and the `USE_COSMOS_NOSQL` switch —
were deleted at Phase 8. All CRUD lives in `src/repositories/*` and every read composes
`src/helpers/access-sql.js`.

The NoSQL client reads `COSMOS_NOSQL_DATABASE` and deliberately ignores `COSMOS_DATABASE`. Pointing
it at the latter once repointed the live app at an empty database that answered `[]` with HTTP 200.

Some implementation details worth knowing before you touch them:

- **`api/index.js`** registers one catch-all Functions route and hands every request to
  `src/http/router.js`, which dispatches against the route table in `src/http/routes.js` — no Express,
  no per-route registrations (the host matches those in discovery order, not by specificity).
- **There is no nightly sync.** The `nightlySyncTimer` is gone, not disabled — the indexers pull every
  five minutes, so there is nothing left for a nightly job to push.
- **GeoJSON is `[longitude, latitude]`** end to end. Cosmos stores it, AI Search indexes it as a
  `GeographyPoint`, and the API returns it unchanged.

Fuller detail: [Architecture](https://github.com/digitalspace/eagle-demi/wiki/Architecture).

---

## Text extraction and chunks

Documents are converted to markdown **off-platform** and posted back:

```
POST /api/documents/:id/chunks     { markdown }  |  { error }
```

The server chunks the markdown (`src/chunker.js` is the only chunking implementation) and copies
`read[]` from the **live** document, so an extraction host can never widen a document's visibility.
Chunk ids are deterministic (`<documentId>::p<page>::c<index>`) and `chunks.replaceForDocument`
reconciles, so the route is idempotent and an interrupted backfill simply restarts. Chunks a
re-ingest drops are deleted from the AI Search `chunks` index first, then from Cosmos, because the
indexer never sees a Cosmos delete. A chunk the index would not delete stays in Cosmos and the
route answers 503, so the retry finds it again. That 503 does not count toward the repeated-failure
lockout, so a search outage cannot lock a document out; a Cosmos write failure is still a counted
500. Known gap: an indexer run already in flight can read a chunk before the index delete and
write it back after. The index also takes about 1 s to make a new write searchable, so the lookup
before the delete can miss a row the indexer wrote just before it. Either way that row stays
searchable until the document's chunks are removed by document id.

> **Do not change `TARGET_CHUNK_SIZE`, `MAX_CHUNK_SIZE` or `OVERLAP_SIZE`.** Chunk ids derive from
> the split, so changing a constant orphans every chunk already written instead of reconciling with
> it. If a chunker change is unavoidable, it lands together with every other pending chunker change
> in a single re-ingest — never two.

Two transport constraints on this route, both found from real documents rather than tests:

- **Send `Content-Length`, never a chunked body.** The Azure front end does not forward a
  `Transfer-Encoding: chunked` body to the Node worker; it arrives as an empty stream and the app
  answers 400, which reads like a malformed payload rather than a transport problem. In Python
  `requests`, pass bytes, never a generator.
- **The platform caps a request at ~230 s (`host.json`) and that applies to streaming writes.**
  Concurrent 30 MB ingests return 504; serialise to one uploader (111 s for the same document).

Documents whose markdown exceeds the 10 MB JSON body limit use `Content-Type: application/x-ndjson`
on the same route — line 1 provenance, lines 2..n JSON-encoded markdown blocks. The dispatcher only
buffers `application/json`, so an NDJSON body arrives unread and the handler reads it off
`req.stream`. Both paths share `createChunkAccumulator`, so a document chunks identically whichever
door it came through.

Two guards stop a bad document from being retried forever:

- **Chunk cap (413).** A document that yields more than `MAX_CHUNKS_PER_DOCUMENT` chunks (default
  25,000) is refused. On the NDJSON path any batches already written are removed from Cosmos and
  AI Search, and the document is marked not extracted.
- **Repeated failures (409).** After `CHUNK_INGEST_MAX_FAILURES` failed ingests (default 3) inside
  `CHUNK_INGEST_FAILURE_WINDOW_MS` (default 24 h), further posts are refused without reading the
  body. Failures include transient ones such as throttling, not only size.

To clear the counter after a fix is deployed, re-post the document as a sysadmin with
`?force=true`; a successful ingest resets it. Or patch `chunkIngestFailures: 0` and
`chunkIngestFailedAt: null` on the document row. The counter also expires on its own once the last
failure is older than the window.

A re-post skips chunks whose stored `itemHash` already matches and writes nothing for them; the
chunk keeps its older parent stamp. A re-stamp walk clears `itemHash`, so the next re-post
rewrites every chunk a walk touched. Skipping also means a re-post does not put back a chunk that
is in Cosmos but missing from AI Search. The recovery for that is a `chunks-indexer` reset (see the devbox `apply` command
above), not a re-ingest.

**Nothing inside Azure extracts text today.** `src/extract.js` holds the only in-repo docling client
and PDF page-batching code; extraction for new projects is deliberately deferred, not cancelled. Do
not delete it as dead code.

It is a **library, not a worker**. The Mongo-driven loop around those two functions was deleted on
2026-08-04 along with the `mongodb` dependency it was the last user of. Reviving extraction means
writing a new driver against Cosmos NoSQL and reusing `splitAndExtract`; it does not mean restoring
the old one.

`extraction-host/` holds the vendored source of the off-platform GPU backfill host. It is Python this
app never loads, and `scripts/package-api.py` excludes it from the deploy package.

---

## Authentication & authorization

See [ADR-004: Read ACL Authorization Model](https://github.com/digitalspace/eagle-demi/wiki/ADR-004-Read-ACL-Authorization-Model)
for the full rationale.

**Authentication.** Keycloak (BC Gov loginproxy), realm `eao-epic`. Tokens are verified against JWKS
with `RS256` pinned and the issuer checked (`src/helpers/auth.js`). `KEYCLOAK_URL`, `KEYCLOAK_REALM`,
`SSO_ISSUER` and `SSO_JWKSURI` must be set per environment — they are, in
`azure/modules/api-function-flex.bicep`. Without them the API falls back to *dev* realm defaults.

**Service-to-service.** Applications authenticate with a **Keycloak service account** —
`client_credentials` against realm `eao-epic`, then a normal `Authorization: Bearer`. Callers that
cannot hold a Keycloak client use a **registry API key** (`X-Api-Key: demi_<env>_<keyId>_<secret>`),
issued through `POST /admin/api-keys` with its own roles, expiry and revocation. `ADMIN_API_KEY` is
now **break-glass only**: one shared secret with no identity, kept so the first registry key can be
minted and as a way in if the registry is unreachable.

Ask for the least privilege that works.

| Role | Reads | Writes data | `/api/admin/*` |
|---|---|---|---|
| `public` | published rows only | no | no |
| `compliance` | sealed rows, on `/api/sealed` only | no | no |
| `demi-service-read` | everything the ACL allows | no | no |
| `demi-service-write` | everything the ACL allows | yes | **no** |
| `staff`, `sysadmin`, `demi-admin` | everything the ACL allows | yes | yes |

Two gates do this, both on top of `authMiddleware`: `requireWrite` (`WRITE_ROLES`) guards data
mutations, `requireAdmin` (`ADMIN_ROLES`) guards `/api/admin/*`. `demi-service-write` is what a
machine writer holds — eagle-api's push, the extractor — so mirroring data never carries the
ability to mint a wider key.

The Eagle mirror, `PUT /api/eagle/*`, is narrower still: only eagle-api may call it. Its handlers
write any project, so `requireEagleMirror` also demands that the caller's registry row id
(`req.user.keyId`) is listed in `DEMI_EAGLE_MIRROR_PRINCIPALS`, that it holds
`demi-service-write`, and that it has no project scope. The setting is a comma list and
defaults to `apim:eagle-api`, which is eagle-api arriving through API Management. Set but empty,
it refuses everyone. Staff users, the break-glass `ADMIN_API_KEY`, the extractor key and any
other minted `demi-service-write` key get 403, and each refusal logs a warning with the
principal and route. See
[ADR-007](https://github.com/digitalspace/eagle-demi/wiki/ADR-007-Service-to-Service-Credentials)
and [Connecting an Application to DEMI](https://github.com/digitalspace/eagle-demi/wiki/Connecting-an-Application-to-DEMI).

The PDF title worker routes, `/api/documents/pdf-title/*` and `/api/documents/:id/pdf-title*`,
use the same check with their own list, `DEMI_PDF_TITLE_WORKER_PRINCIPALS` (bicep
`pdfTitleWorkerPrincipals`). It has no default: unset or empty, the routes refuse everyone. Never
put one principal on both lists, or one key can both mirror Eagle data and rewrite stored PDFs.

**Never hardcode a key literal** — this repository is public, so a literal there is a world-readable
credential. (`DOCLING_API_KEY` was exactly that until it was split out; it is now outbound-only and
401s inbound.)

**Authorization — the `read[]` ACL.** Records carry a `read[]` array of role *types*. A record is
visible when `read[]` intersects the caller's roles. `read[]` is authoritative; `isPublished` is a
mirror of it, never an independent signal.

```js
const { resolveAccess, visibilityFor, canRead } = require('../helpers/access-sql');

const access = resolveAccess(req);                 // tier + roles + projectScope
const rows   = await documents.listVisible(access, { projectId });

// Point reads bypass the query predicate — gate them explicitly:
if (!canRead(doc, access, 'projectId')) return res.status(404).json({ error: 'Not found' });
```

A hidden record returns **404, not 403** — a 403 would confirm the id exists.

Project scope is a second, orthogonal dimension: it arrives as Keycloak roles prefixed `project:`
(`project:207`) and rides the partition key. `rolesFor()` strips `project:*` from the role list so a
project id can never enter the `read[]` clause.

Orthogonal means **both** apply. A privileged credential carrying a scope is privileged *within
those projects*: `readClause` collapses to `true` for the role set while `scopeClause` still
narrows. `resolveAccess` therefore resolves scope BEFORE the privilege check — reversing that order
silently discarded the scope, so a key minted as `roles:['staff'], projectScope:['207']` read the
whole corpus.

A container with no project axis passes a **null** partition field, which makes `scopeClause`
return `true`: boundaries are administrative geography, so the role ACL applies and the project
narrowing does not. Scoping them on a `projectId` the items do not carry would match nothing and
blank the map for every scoped caller.

`systemAccess()` is the only context that reads past ACLs (chunk ingest, maintenance scripts). It
takes no arguments, so it cannot be derived from a request, and it resolves *through* the same
predicate rather than bypassing it.

### Query layer rules

- `src/db/cosmos-nosql.js` takes **query specs** — `{query, parameters}` — and throws on anything
  else. There is deliberately no Mongo→SQL translator: one handling most operators fails **open** on
  the rest, which is how access control was disabled here once already.
- Counts must use the **same** predicate as the read, or totals leak hidden records.
- **Index before you sort.** Cosmos rejects `ORDER BY` on an unindexed path; add it to
  `azure/modules/cosmos-nosql.bicep` first.
- `patch()` is capped at 10 ops. `upsert()` replaces the whole item and will erase fields written by
  another path.
- Paging uses continuation tokens, not skip/take.

---

## Document storage & downloads

Request paths always go through **`src/storage/`**, which exposes two operations —
`getDownloadUrl` and `putFile`. Reaching past it from a request path previously produced two bugs at
once. The backend modules also export `getBuffer` and `describe`, used only by the one-off scripts
under `src/scripts/`.

Backend is chosen by an explicit `STORAGE_BACKEND` (`minio` | `azure`); an unknown value throws at
load. It is never inferred from whichever credentials happen to be present. It is set explicitly to
`minio` on `demi-api-dev` (2026-08-04) rather than resting on the default in `src/config.js`.

MinIO settings: `MINIO_HOST`, `MINIO_BUCKET_NAME`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, plus
**`MINIO_PORT=443`**, **`MINIO_USE_SSL=true`** and a pinned region — without an explicit region the
SDK does a bucket-region lookup on every presign that hangs ~135 s before failing. Dev also needs
**`MINIO_KEY_PREFIX=ozwdez`**: the bucket holds a nested copy of prod, so recorded keys sit one
segment deeper. The prefix is applied inside the backend; callers pass the recorded `s3Key`. Test
(`zdspnb`) and prod (`ozwdez`) keep keys at the bucket root and set no prefix.

**Downloads:** `GET /api/documents/:id/download` returns a 5-minute presigned URL, gated by the same
ACL as the metadata read — a caller who cannot see a document cannot fetch its bytes. The URL says
`attachment`; `?inline=1` makes a PDF or a PNG, JPEG, GIF or WebP image open in the browser instead,
and every other type stays a download. The JSON body's `inline` field says which one this file got.
A `HEAD` on the same path is answered by DEMI itself and never redirects, because the presigned URL is signed
for GET only: 200 with the file's `Content-Type`, `Content-Length` and `Content-Disposition`, or the
same 404 as GET. HEAD also checks the store. If the store says the object is missing, HEAD returns
404, while GET still returns a link. If the store times out (3 seconds) or is down, HEAD answers from
the document record. Any other store error, such as access denied, is a 500.

---

## CSV reports

Two eagle-api CSV reads have DEMI handlers. Rows and fields come from DEMI's own access rules, not
from eagle-api's role checks.

| Path | Handler | Replaces in eagle-api |
|---|---|---|
| `GET /commentperiods/:periodId/comments/export` (signed in) | `src/controllers/nosql/comment-export.js` `exportComments` | `GET /api/comment/export/{periodId}` |
| `GET /reports?type=bcgw` (public) | `src/controllers/report.js` `getReport` | `GET /api/reports?type=bcgw` |

**Comment export.** The caller's level picks the columns. Level 2 or lower (sysadmin, staff) gets
the staff columns. Any other level gets the proponent columns and only published comments. In both,
`Author` reads `Anonymous` on an anonymous comment, as in eagle-api. Rows are the comments the caller can
read, and each row goes through the field redactor first, so a hidden field is an empty cell.
Attachment links point at `/documents/:id/download` on the host the caller used, and list only
documents the caller can read. Text that starts with `=`, `+`, `-` or `@` gets a leading `'` so a
spreadsheet does not run it as a formula. `Pillar` is always empty: DEMI does not copy that field.

**BCGW report.** The feed of published projects for the BC Geographic Warehouse. It always reads
as an anonymous caller, so a signed-in caller gets the same file. Columns and values match
eagle-api's file, including the `Project GUID` cell wrapped in quotes that eagle-api has always
written.

Both responses are built whole, because the Functions host sends one buffered body.

---

## Project data model

Projects are a merge of two upstream sources, keyed by the Track project id:

- **`sources.track`** — EAO project attributes from EPIC.track (`epictrack-api`), authoritative.
- **`sources.eagle`** — legacy EAGLE portal records, which fill gaps Track does not carry.

Track wins and Eagle fills gaps, via an explicit field map rather than an object spread — a spread
overwrites with `undefined` and silently erases data. `src/merge/project.js` holds the rules and is
pure, because merge bugs are silent.

**Projects are never created from an ingest.** A row whose upstream id does not resolve to a project
already in the registry is dropped and counted, never given an invented parent. Auto-seeding them is
what produced 3,382 synthetic project rows in the old database.

---

## Deployment

**The environment model: Azure dev is a sandbox, test is staging, prod is prod** (decided
2026-08-10). Staging lives in `c4b0a8-test-rg` (subscription `c4b0a8-test`) as `demi-api-fc-test` plus
the `demiwebtest…` static-website storage account, deployed from `azure/main.test.bicepparam`.

`FRONTEND_STORAGE_ACCOUNT` has **no default and cannot be guessed** — the account name carries a
`uniqueString` suffix. Take it from the `frontendStorageAccountName` output of the newest
`deploy-infra.sh <env> --foundation` run (deployment `infra-fnd-<sha>-<hhmmss>`). An
application-only run emits that output, `frontendStaticSiteHostName` and `apimGatewayUrl` as empty
strings. The script aborts rather than inventing one, and `all` therefore needs it too.

```bash
# API by hand (Flex publishes through config-zip; deploy-azure.sh is frontend-only):
BUILD_ID="$(git describe --tags --always)-$(date -u +%H%M%S)" python3 scripts/package-api.py . /tmp/api.zip
az functionapp deployment source config-zip -g c4b0a8-test-rg -n demi-api-fc-test --src /tmp/api.zip

FND=$(az deployment group list -g c4b0a8-test-rg \
  --query "[?starts_with(name, 'infra-fnd-') && properties.provisioningState=='Succeeded'] | sort_by(@, &properties.timestamp) | [-1].name" -o tsv)
FRONTEND_STORAGE_ACCOUNT=$(az deployment group show -g c4b0a8-test-rg -n "$FND" \
  --query properties.outputs.frontendStorageAccountName.value -o tsv) \
  ./scripts/deploy-azure.sh frontend c4b0a8-test-rg
```

Build the package from a checkout that already has `node_modules` installed — `ENABLE_ORYX_BUILD` is
`false`, so nothing installs dependencies on the Azure side.

### Prod infrastructure

`rg-demi-prod` in `c4b0a8-prod`, from `azure/main.prod.bicepparam`. It deploys no search service —
`demi-search-prod` already exists and also serves `eagle-search-api-prod`, so the template only
grants the DEMI identity Search Index Data Contributor on it and adds the shared private link it
needs to reach the new Cosmos account — and no Foundry account, no `wildfires` container and no
static site. The `boundaries` container IS deployed everywhere, empty in prod: it is reference data
that `GET /boundaries` and `GET /db/stats` read unconditionally.

That shared private link is created in `Pending`. **Approve it once after the apply** or every
indexer fails with a connectivity error, because `demi-cosmos-prod` is `publicNetworkAccess:
Disabled`:

```bash
az cosmosdb private-endpoint-connection list -g rg-demi-prod --account-name demi-cosmos-prod
az cosmosdb private-endpoint-connection approve --id <connection-id>
```

Approval opens the route but grants nothing: `demi-search-prod` runs its indexers as
`eagle-search-identity-prod`, so the template also gives that principal
(`existingSearchIndexerPrincipalId`) the Cosmos SQL Data Reader role. Without both, indexers get a
403 instead of a connection error.

The API is `demi-api-fc-prod` on its own FC1 plan — a Flex plan cannot be shared, so there is no
App Service plan to size or join. Data-plane work goes through `demi-devbox-prod`, the VM in the
landing-zone VNet; see "Running anything against the database".

Object-store credentials come from the `nr-object-store-credential` secret in `6cdc9e-prod`
(`user_account` / `password`). The credentials the app resolves by reference come from
`demi-kv-prod` — see "Secrets live in Key Vault" below.

```bash
# what-if — the default, nothing is applied
./scripts/deploy-infra.sh prod

# apply
CONFIRM_PROD=yes ./scripts/deploy-infra.sh prod --live
```

`--live` is required to apply in every environment; prod additionally refuses without
`CONFIRM_PROD=yes`.

The plain command deploys the application layer only — the Function App, the secret sync, the
availability test and the devbox. `--foundation` deploys everything, and is required after a change
to one of the twelve foundation modules under `azure/modules/`: `identity`, `key-vault`,
`cosmos-nosql`, `observability`, `audit-logs`, `foundry`, `ai-search`, `search-existing`, `apim`,
`static-site`, `document-storage`, `cost-budget`.

```bash
# foundation and application together
CONFIRM_PROD=yes ./scripts/deploy-infra.sh prod --foundation --live
```

An application run compares those modules against the commit the last `--foundation` run deployed
from. If any of them changed, or has an uncommitted edit, it refuses under `--live` and warns under
what-if. A change to `azure/main.bicep` or a `.bicepparam` file only warns, because those files
change for application work too.

### Cosmos indexing policy only

A change to one container's `indexingPolicy` in `azure/modules/cosmos-nosql.bicep` does not need a
`--foundation` run (about 32 minutes on prod). `scripts/apply-cosmos-index.sh` applies just that
policy in about a minute.

```bash
# dry run: diff live against declared, apply nothing
./scripts/apply-cosmos-index.sh test documents
./scripts/apply-cosmos-index.sh prod documents

# apply, then re-read and check the live policy matches
./scripts/apply-cosmos-index.sh test documents --live
CONFIRM_PROD=yes ./scripts/apply-cosmos-index.sh prod documents --live

# print the declared policy only, no Azure login needed
./scripts/apply-cosmos-index.sh extract documents
```

It compiles `azure/modules/cosmos-nosql.bicep`, takes the named container's policy, and compares it
with the live one on `demi-cosmos-<env>`. It never changes throughput. Cosmos rebuilds the index in
the background after the update, so queries on a new path can scan until that finishes.

A dry run needs no `CONFIRM_PROD`, on prod too. `--live` refuses while `cosmos-nosql.bicep` has
uncommitted changes. Prod `--live` also needs `CONFIRM_PROD=yes`, a working `git fetch` of
`origin/main`, and a `cosmos-nosql.bicep` identical to the one on `origin/main`.

Dry run or not, it prints a warning when the declared policy drops indexing the live one has: a
removed included path, composite index or spatial index, a new excluded path, or `indexingMode:
none`. `--live` refuses a container that sets `analyticalStorageTtl` or `computedProperties`,
because `az cosmosdb sql container update` does not carry them over.

Exit codes: 0 no drift, or applied and confirmed; 1 failure, including a diff error and a live
policy that still differs after the update; 2 bad usage or refused; 3 dry run found drift.

It does not record a foundation deployment. The next `deploy-infra.sh <env> --live` still sees
`cosmos-nosql.bicep` changed since the last `--foundation` run and refuses until one runs.

### Secrets live in Key Vault

`demi-kv-<env>` holds the credentials the API resolves at runtime as
`@Microsoft.KeyVault(SecretUri=...)`. The names it must hold:

| Secret | What it is | Where it is required |
|---|---|---|
| `admin-api-key` | break-glass sysadmin credential | every environment |
| `track-client-secret` | Keycloak client secret of the Track service account | every environment |
| `role-sync-client-secret` | Keycloak client secret the team sync grants roles with | every environment |
| `docling-api-key` | outbound key DEMI presents to docling-serve as `X-Api-Key` | every environment |
| `minio-access-key` | object-store access key for the NRS store the corpus lives in | every environment |
| `minio-secret-key` | object-store secret key paired with it | every environment |
| `analytics-shared-header` | header APIM stamps on every analytics call, which that app demands | every environment |
| `analytics-audit-header` | second credential APIM stamps on `POST /analytics-machine/audit` alone | every environment |
| `notify-api-key` | function key eagle-notify accepts on `POST /api/events` | only where `notifyApiBase` is set |
| `edge-secret` | value the eagle-edge Front Door rule set stamps as `X-Edge-Secret` | only where Front Door fronts the app |
| `access-gate-password` | password `POST /api/gate` accepts, gating the public site | only where the site runs a curtain; not prod |
| `pdf-title-worker-api-key` | registry key the PDF title worker presents as `X-Api-Key` | only where `deployPdfTitleWorker` is true; see [PDF title worker](#pdf-title-worker) |
| `openshift-token-<env>` | ServiceAccount token the secret sync writes OpenShift Secrets with | `demi-kv-test` only; prod runs no sync |
| `dev-openshift-token` | the same for `6cdc9e-dev`, which `demi-kv-test` also serves | `demi-kv-test` only |

The first eight are the required set, written down once in `requiredSecretNames` in
`azure/modules/key-vault.bicep`. The rest are optional per environment and are listed in that
environment's `optionalSecretNames` parameter. Naming one there says the vault holds it; an unnamed
one leaves its app setting empty, which is what a dark environment wants.

The two analytics headers are not read by the API app. APIM resolves them as Key Vault-backed named
values, so the gateway is no longer a second copy of them, and eagle-analytics reads the same two
secrets as `APIM_SHARED_HEADER_VALUE` and `AUDIT_SHARED_HEADER_VALUE`. Both sides have to be
recycled after a rotation.

**Values are set once by hand, from the devbox, and never through git, a workflow input or a
template parameter.** The Bicep has no parameter carrying a secret value, so an infrastructure
deploy cannot blank a live credential. Rotation is the same command as the first write: a new
version, then recycle the app (`stop` then `start` — `restart` does not re-read a reference).

```bash
# on demi-devbox-<env>, which runs as demi-identity-<env>
az keyvault secret set --vault-name demi-kv-<env> --name admin-api-key --value '<value>'
az keyvault secret list --vault-name demi-kv-<env> -o table
```

The same list from anywhere else answers `ForbiddenByConnection`, owner or not: landing-zone policy
`Deny-PublicPaaSEndpoints` forces `publicNetworkAccess: Disabled`, so the only route in is the
vault's private endpoint. That failure is the control, not a problem to route around — it is also
why `peSubnetId` has no default in `azure/modules/key-vault.bicep`.

`deploy-infra.sh` checks the live vault against the expected names from the devbox before it
deploys anything, and refuses when one is missing, because a reference to a secret nobody set
resolves to nothing and reports no error.

### OpenShift secret sync

Some of the same credentials are also needed by workloads in OpenShift, which cannot read the vault
itself: the cluster cannot federate to Entra, and the vault answers only inside the VNet. So a
second Function app, `demi-secret-sync-<env>`, copies them out. It reads mapped secrets from the
vault, writes each one into the OpenShift Secret that consumes it, and stamps the pod template of
every workload that reads it so the pods pick up the new value.

**Test only.** `demi-secret-sync-test` is the one sync app, and it owns `6cdc9e-dev` and
`6cdc9e-test`. There is no prod sync app: the prod spoke has no route table and policy forbids
creating one, so an app there could not reach the OpenShift API on 6443. Prod OpenShift secrets
stay in OpenShift and are set by hand; `demi-kv-prod` holds only what Azure itself reads, through
Key Vault references from `demi-api-fc-prod`. `deploySecretSync` in `azure/main.prod.bicepparam` is
false, so a prod infrastructure deploy creates no sync app.

- Code: `src/secret-sync/`. Infrastructure: `azure/modules/secret-sync.bicep`.
- The app routes ALL outbound traffic through the VNet (`outboundVnetRouting.allTraffic: true`), not
  just vault traffic. Its subnet also needs the landing-zone route table `openshift-public-endpoint`
  attached, or hub BGP routes swallow the OpenShift API's public range (`142.34.0.0/16`) and port
  6443 is dropped: `az network vnet subnet update -g c4b0a8-<env>-networking --vnet-name
  c4b0a8-<env>-vwan-spoke -n snet-demi-func-fc1-<env> --route-table openshift-public-endpoint`. Done
  on test 2026-09-11.
- Triggers: an Event Grid subscription on the vault (`SecretNewVersionCreated`, filtered to mapped
  names) and a daily timer at 06:00 UTC for drift. Both run the same reconcile.
- A run that finds nothing changed writes nothing and restarts nothing.
- A write overwrites the mapped keys and leaves every other key of that Secret as it is, so a key
  set by hand or by a Helm release is neither deleted nor treated as drift.
- A mapped secret missing or empty in the vault leaves the live OpenShift Secret untouched and
  fails the run, so a rotation half-done never lands as a Secret with a key deleted.
- It overwrites values, it never creates objects. The cluster Role grants `update` on the named
  Secrets and no `create`, because an unnamed `create` would let the ServiceAccount mint a Secret
  of any type, a service-account token for another account included. A mapped Secret the namespace
  does not have is logged and counted missing, and fails the run the same way.
- `SYNC_NAMESPACES` on the app is what decides which namespaces it writes to, and the app can only
  reach what its token opens: it holds no prod token.

**The mapping file** is `src/secret-sync/mapping.json`. It holds names only, never values: one entry
per key, saying which vault secret feeds which key of which OpenShift Secret, and which Deployments
and CronJobs to roll when it changes. It holds dev and test entries only. An OpenShift Secret with
several keys — `eagle-api-mongodb` has five in dev, `rproxy-basic-auth` four in dev and test — is
several entries merged into the one Secret object.
Dev names carry a `dev-` prefix because `demi-kv-test` is the nonprod vault and serves both nonprod
namespaces.

**To add a secret**: set the value in the vault from the devbox
(`az keyvault secret set --vault-name demi-kv-<env> --name <name> --value '<value>'`); create the
OpenShift Secret once by hand if the namespace does not already have it
(`oc create secret generic <name> --from-literal=<key>=placeholder`, any placeholder value — the
first run overwrites it); then add one line per key to `mapping.json`, and merge. The staging
workflow deploys it on push to main. The next event or the next daily run writes it.

**To force a run**: create a new version of any mapped secret, or run the timer by hand from the
portal (`demi-secret-sync-test` → Functions → `secretSyncDaily` → Code + Test → Run). The run logs
one line with its counts: `checked`, `updated`, `restarted`, `missing`.

**To disable it**: stop the function app
(`az functionapp stop -g <rg> -n demi-secret-sync-test`). Nothing else depends on it running — the
secrets it last wrote stay where they are, and deploys bind them by name.

### PDF title worker

`demi-pdf-title-<env>` is a third Function app, a Python timer app on Flex Consumption. On the
schedule in `PDF_TITLE_SCHEDULE` it runs `pdf-title/run.py`, which takes PDFs without a title from
the API's work list and sets one. It is a dry run, listing the work and writing nothing, unless
`PDF_TITLE_LIVE` is `true`.

On test, `azure/main.test.bicepparam` enables it live (`pdfTitleLive = true`); set it to `false` to list work and write nothing. Prod
deploys the worker with `pdfTitleLive = false` until the first live tick is verified.

- Code: `pdf-title/`. Infrastructure: `azure/modules/pdf-title-worker.bicep`. Workflows:
  `.github/workflows/azure-deploy-staging-pdf-title.yaml` for test, and the `deploy-pdf-title` job
  in `.github/workflows/azure-deploy-prod.yaml` for prod.
- It has its own identity, `demi-pdf-title-identity-<env>`, not `demi-identity-<env>`. The identity
  reads one vault secret and its own host storage, and nothing else.
- It calls the API Function app directly at `DEMI_API_URL`, not through APIM, with
  `DEMI_API_KEY` as `X-Api-Key`. `DEMI_API_KEY` is a Key Vault reference to
  `pdf-title-worker-api-key`.
- Other settings: `PDF_TITLE_MAX_ROWS` (rows per run), `PDF_TITLE_MAX_MINUTES` (after this many
  minutes a run starts no new row; must be set and below 15), `PDF_TITLE_CONCURRENCY`. The bicep
  parameters are `pdfTitleLive`, `pdfTitleMaxRows`, `pdfTitleMaxMinutes` and `pdfTitleSchedule`.

Backup gate: the API refuses every lease until `backupAccountName` is set for that environment
(app setting `BACKUP_ACCOUNT`). Even then it grants a lease only when the document's original is in
the `originals` container (`backupContainerName`, app setting `BACKUP_CONTAINER`), in Archive tier,
with matching size and MD5. Test and prod both set it.

**To enable it in an environment**, in that environment's param file:

1. Set `deployPdfTitleWorker = true`. `apiFlexSubnetId` must also be set, because the worker reads
   the API host from the Flex API module.
2. Add `pdf-title-worker-api-key` to `optionalSecretNames`. `deploy-infra.sh` refuses to deploy
   until the vault holds the secret, and the app is created only when the flag, the secret and
   `apiFlexSubnetId` are all set.
3. Mint the key (below) and put its key id in `pdfTitleWorkerPrincipals`. Until then the API
   refuses the worker on every route.
4. Run `scripts/deploy-infra.sh <env> --live`.
5. Grant `demi-cicd-test` Website Contributor on the new app (see
   the RBAC row in the CI identity table under Deployment), so the workflow can deploy it.

**To mint the key**, from the devbox, as a caller that holds `sysadmin`. The key has the role
`demi-service-write`, `allowWrite: true` and no project scope. The plaintext goes straight into the
vault and is never printed:

```bash
curl -sS -X POST "$DEMI_API/admin/api-keys" -H "X-Api-Key: $DEMI_KEY" \
  -H 'content-type: application/json' \
  -d '{"name":"pdf-title-worker <env>","roles":["demi-service-write"],"allowWrite":true}' \
  | jq -j .key \
  | az keyvault secret set --vault-name demi-kv-<env> --name pdf-title-worker-api-key \
      --file /dev/stdin --encoding utf-8 --content-type text/plain \
      --expires "$(date -u -d '+89 days' +%Y-%m-%dT%H:%M:%SZ)" \
      --query attributes.enabled -o tsv
```

The landing-zone policy `Enforce-GR-KeyVault` refuses a secret with no content type or no expiry
date, so the command sets both.

The key must be stored without a trailing newline, which `jq -j` guarantees; a newline in the
secret breaks the worker's `X-Api-Key` header.

Read the key's id from `GET /admin/api-keys`; it is the value for `pdfTitleWorkerPrincipals`. To
check the secret, use `--query attributes.enabled`. Never use `--query value`: it prints the key.

**To rotate the key**, before the 90-day expiry:

1. Mint a new key as above. `az keyvault secret set` writes a new version of the same secret.
2. In `pdfTitleWorkerPrincipals`, list both key ids, comma-separated.
3. Run `scripts/deploy-infra.sh <env> --live`.
4. Recycle the app so it reads the new version: `az functionapp stop`, then `start`
   (`restart` does not re-read a reference).
5. Check that the next run succeeds, then revoke the old key with
   `DELETE /admin/api-keys/<old id>`.
6. Remove the old id from `pdfTitleWorkerPrincipals` and deploy again.

**To stop it**: either stop the app
(`az functionapp stop -g <rg> -n demi-pdf-title-<env>`), or set `pdfTitleLive = false` and deploy
infrastructure, which turns the next runs into dry runs. A run killed part way is safe: the next
run sweeps what it left.

**The deploy workflow** pushes the code on a push to main that touches `pdf-title/`. It first asks
Azure for the app. If the app does not exist, or CI does not hold Website Contributor on it, the
workflow prints a notice and skips the deploy instead of failing. Any other error fails the run.
After a deploy it waits until the function `pdf_title_run` is registered.

In prod the same steps run as the `deploy-pdf-title` job of the prod deploy workflow, after the API
job, from the tag being deployed. It also skips when that tag has no `pdf-title/function_app.py`.
The prod rollback job redeploys the API only, never the worker.

### `demi-frontend-test` is gone — decommissioned 2026-08-15

The App Service and the B1 plan it shared with eagle-public's preview were deleted once the Front
Door endpoint was verified in a browser. Two things from that generalise, and one is repo-specific:

- **Deleting a module stops ARM *managing* a resource; it does not delete it.** `what-if` reports
  the orphan as `Ignore` and it keeps running and billing. Complete-mode would remove it and is
  **not** an option here — it deletes everything in `c4b0a8-test-rg` absent from the template,
  Cosmos and AI Search included. Orphans go by hand or not at all.
- **Take the origin out of `frontendHostNames` before deleting the host.** An `*.azurewebsites.net`
  name returns to Azure's global pool on deletion, so an entry left in `CORS_ORIGIN` is a
  cross-origin position against `demi-api-fc-test` that someone else can register.
- `demi-api-fc-test` runs on its own plan `demi-plan-fc-test`. Check plan tenancy before any
  deletion here, because plan names differ by one token.

### Three manual steps the templates cannot do

Do these once per environment, in this order, or the frontend is a set of blobs nobody can reach.

Two things that used to be on this list are now automatic, and are recorded here only so nobody
re-adds them. `frontendUploaderPrincipalId` is **set** in `azure/main.test.bicepparam`
(`39682a03-…`, the object id of `demi-cicd-test` — not its client id), so `static-site.bicep`
assigns the CI identity both roles it needs. And **static website hosting is enabled by
`scripts/deploy-azure.sh frontend` on every deploy**, idempotently:

```bash
az storage blob service-properties update --account-name <frontendStorageAccountName> \
  --auth-mode login --static-website --index-document index.html --404-document index.html
```

Both documents are `index.html` because this is an SPA; skip it and every blob uploads fine while
the site 404s. That is a *service-properties* write, so it needs **Storage Account Contributor**,
which Blob Data Contributor does not imply — `static-site.bicep` now assigns it alongside the data
role. Handing CI a role carrying `listKeys` is only acceptable because the account sets
`allowSharedKeyAccess: false`, which makes those keys unusable; do not re-enable shared keys
without revisiting that grant. A missing grant fails the first step of
`scripts/deploy-azure.sh frontend` with a 403, before the build.

1. **Give eagle-search the origin hostname.** `main.bicep` outputs `frontendStaticSiteHostName`
   (`demiweb….z13.web.core.windows.net`) from a `--foundation` run only; an application-only run
   emits it empty. It goes into eagle-search's `demiFrontendWebHostName`
   parameter, which is what adds DEMI's route to the shared Front Door profile.

2. **Add the AFD hostname to `frontendHostNames` BEFORE publishing the frontend to it.** An AFD
   endpoint is `<name>-<hash>.<zone>.azurefd.net` and **Azure assigns both the hash and the zone
   code**, so it cannot be composed, guessed or written ahead of the deployment. Take it from
   eagle-search's `edgeEndpointHostNames` output, append it to `frontendHostNames` in
   `azure/main.test.bicepparam`, and redeploy this template. That is what sets `CORS_ORIGIN` on
   `demi-api-fc-test`, and it also sets the Flex app's own platform CORS — **both layers, and the
   platform one answers the preflight first**, so neither alone is enough.

   The parameter is an ARRAY because a cutover has two frontends at once. Getting the order wrong
   is not theoretical: on 2026-08-15 the AFD frontend was published while this still named only the
   App Service, and the result was a site that loaded perfectly and then failed every single
   request — `/api/config` and both `/api/search` calls blocked with *"No
   'Access-Control-Allow-Origin' header is present"*. Nothing in either deployment reported a
   problem, because nothing in either deployment was wrong. **List the new origin first, publish
   second, drop the old origin last.**

   An empty array is the pre-Front-Door state and fails closed: `CORS_ORIGIN` is unset,
   `src/http/router.js` falls back to an allowlist holding only `http://localhost:4200`, and the frontend's first XHR
   fails loudly rather than silently reflecting any origin.

3. **Register the AFD hostname with Keycloak, before decommissioning the old App Service.**
   This is the one step with no code anywhere in these repos, and nothing fails loudly enough to
   point at it. `registry-state.service.ts` derives both `redirectUri` and
   `silentCheckSsoRedirectUri` from `window.location.origin`, so moving the frontend to a new
   hostname changes both. The client's registered URIs are **exact-host patterns**, so an
   unregistered host gets `400 Invalid parameter: redirect_uri` from the realm's authorize endpoint —
   which means CORS and CSP can all be correct on cutover day and staff still cannot log in. Probe it
   directly before believing otherwise; the test environment's AFD host was registered on 2026-08-14
   and staff login confirmed working the same day.

   **This does not need another team.** The `demi-keycloak-admin` secret in `6cdc9e-test` holds
   credentials that can update the client directly, and doing so is a single admin-API call. Read
   the client, append to `redirectUris` and `webOrigins`, PUT the whole object back — appending to
   what you just read is the only safe shape, because the API replaces the arrays it is given and a
   hand-written one silently drops the other dozen entries. Add, on client `eagle-admin-console` in
   realm `eao-epic`, in the realm matching the environment's `KEYCLOAK_URL`:

   - Valid Redirect URIs: `https://<afd-endpoint>/*` — covers both `/` and `/silent-check-sso.html`
   - Web Origins: `https://<afd-endpoint>` — the token and userinfo XHRs are checked against this

   **Remove any `demi-frontend-<env>.azurewebsites.net` entries.** That name is back in Azure's
   global pool, so a redirect URI on it points at whoever claims it next.

   Failure signature if this is skipped: clicking Log In lands on Keycloak's
   `Invalid parameter: redirect_uri` error page. Worse, once a user has `isLoggedIn` set on the new
   origin the same rejection happens inside the hidden silent-SSO iframe, where it is invisible —
   the `Promise.race` times out after 5s and the app settles into public mode showing no staff-only
   data, with nothing in the console but a blocked navigation.

### Two accepted ceilings

- **The `$web` endpoint stays publicly reachable, so Front Door can be bypassed.** Accepted; the
  reasoning lives once in `eagle-search`'s README, which owns the Front Door profile and both
  storage accounts. The copy that used to be here had already drifted from it.
- **Nothing in front of the frontend authenticates.** `$web` is anonymous by definition, and an AFD
  rule-set rule can only rewrite and set headers — no action challenges a request for credentials.
  DEMI's own Keycloak login still gates staff data, since it is in the app, but the shell is open to
  anyone with the hostname. Note that login is not automatically carried over: the new origin has to
  be registered on the Keycloak client first — step 3 above. The upgrade that keeps this SKU is a **WAF custom rule** on the endpoint (match +
  Block, e.g. an IP CIDR); Standard supports custom rules, and only *managed* rule sets are
  Premium-only.

**CI deploys staging on every push to `main`.** It runs the same script — the
workflow installs dependencies, logs in, and calls `./scripts/deploy-azure.sh`, so CI and a manual
deploy cannot drift.

The frontend and the API are **separate workflows with separate triggers**, so a change to one does
not redeploy the other:

| Workflow | Deploys | Fires on a push to `main` touching |
|---|---|---|
| `azure-deploy-staging-frontend.yaml` | `$web` on the static-website storage account (repo variable `AZURE_FRONTEND_STORAGE_ACCOUNT`) | `frontend/**` |
| `azure-deploy-staging-api.yaml` | `demi-api-fc-test` | `src/**`, `api/**`, `public/**`, `index.js`, `host.json`, `package.json`, `yarn.lock`, `frontend/public/assets/geojson/**` |
| `azure-deploy-staging-pdf-title.yaml` | `demi-pdf-title-test`, when it exists (see [PDF title worker](#pdf-title-worker)) | `pdf-title/**` except tests, `scripts/package-pdf-title.sh` |
| `draft-release.yaml` | nothing — mints the tag and draft release for the same push (see [Releases](#releases)) | *any path* |

**The two staging workflows stay separate, and `draft-release.yaml` is a third.** Folding the deploys
into one "Deploy to Test" was considered and rejected: they have different path filters, different
concurrency groups, different Node versions, different Azure targets under different RBAC (Website
Contributor on a Function App vs Storage Blob Data Contributor on `$web`), and only the frontend
rewrites `env.js`. One workflow would have to re-derive "did the frontend change?" at runtime to keep
the current behaviour, which is the coupling the 2026-08-05 split removed. Tagging is the one thing
that must happen once per push regardless of paths, so it lives in the workflow that has no path
filter.

All three also accept `workflow_dispatch`. The API's paths mirror `scripts/package-api.py`, which decides
what actually ships — root `public/` is not excluded there, and `frontend/public/assets/geojson/**`
is explicitly re-included because the boundary seeder reads it at runtime, so that one path fires
both workflows. Adding a directory to the package without adding it here gives you a deploy that
silently never runs.

GitHub Actions authenticates as the user-assigned managed identity **`demi-cicd-test`** through a
federated credential, with no client secret anywhere:

| | |
|---|---|
| Identity | `demi-cicd-test`, in `c4b0a8-test-rg` |
| Federated credential | issuer `https://token.actions.githubusercontent.com`, subject `repo:digitalspace/eagle-demi:environment:test`, audience `api://AzureADTokenExchange` |
| RBAC | Website Contributor on `demi-api-fc-test` and on `demi-pdf-title-test`, each granted **individually** by hand, outside bicep (the worker app exists only once `deployPdfTitleWorker` is true), plus Storage Blob Data Contributor (publish the bundle) **and** Storage Account Contributor (enable static website hosting) on the static-website account — both assigned by `static-site.bicep` from `frontendUploaderPrincipalId`. Nothing at resource-group scope. Website Contributor gives nothing at all on a storage account, and the data role alone cannot turn `$web` on |
| Config | All four values live on the **`test` GitHub environment**, nothing at repo scope and nothing hardcoded: secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`; variables `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP` |

**Declaring `environment: test` changes the OIDC subject claim, and that is the trap.** With an
environment the claim becomes `repo:digitalspace/eagle-demi:environment:test` rather than
`repo:digitalspace/eagle-demi:ref:refs/heads/main`. The subject is the whole contract; it is not
derived from anything the workflow can set. Rename the environment, or delete the `gh-env-test`
federated credential, and Azure Login fails with `AADSTS700213: No matching federated identity
record found for presented assertion subject` — so always create the credential for the new subject
before renaming, prove a deploy green, and only then remove the old one. (The dev-era `demi-cicd-dev`
identity and its `gh-main`/`gh-env-staging` credentials go away with the dev teardown.)

**A managed identity, deliberately, not an app registration.** A UAMI carries federated credentials
just as an Entra application does, but creating and configuring one is pure ARM. The app-registration
route needs Microsoft Graph to create the service principal and the credential, and conditional
access blocks Graph here — browser sign-in has no browser on a server, and device-code flow is denied
tenant-wide. The landing zone points the same way: managed identity first, app registration only for
human sign-in, multi-tenant or M365 integration, and by request rather than self-service.

`demi-cicd-test` is separate from the runtime identity `demi-identity-test` on purpose. The runtime
identity holds Cosmos Data Contributor, Search Index Data Contributor and OpenAI User; a federated
credential on it would let any workflow on `main`, in a **public** repo, mint a token with full
database access.

The script carries no credential of its own — `az account get-access-token` returns a token for
whatever principal the CLI session holds, a human locally and the managed identity in CI. Its
`preflight_identity` prints that principal and refuses to run under `GITHUB_ACTIONS` as anything but
a service principal, so a deploy authenticated as a person fails instead of proceeding.

**The prod deploy workflow is back**: `.github/workflows/azure-deploy-prod.yaml`,
`workflow_dispatch` only, taking a `version` and checking out `refs/tags/<version>` — a tag verified
on staging, never a branch. Its jobs run in this order: `verify-search-schema`, `deploy-extractor`,
`deploy-api`, then `deploy-pdf-title` (skipped with a notice while `demi-pdf-title-prod` does not
exist). Every Azure job declares `environment: prod`, which is what produces the OIDC
subject `repo:digitalspace/eagle-demi:environment:prod`; renaming the environment breaks the
federated credential. An earlier note here said no prod workflow existed, which was true only
between 2026-08-05 and the prod estate being built.

Its last job, `publish-release`, flips that version's draft release to published and marks it latest.
It runs only when every deploy job has succeeded, holds `contents: write` and nothing else, and
declares no `environment:` — it touches no Azure resource, and a second approval gate in front of
"record that the approved deploy finished" would be theatre. See [Releases](#releases).

Recreating them is not a copy job. Each environment needs its own managed identity, its own federated
credential — subject `repo:digitalspace/eagle-demi:environment:test` or `:environment:prod`, matching
its GitHub environment — its own role assignments, and for prod a decision about required reviewers
on the environment. Build them from the dev pair when that work actually starts.

**`azure/main.bicep` now describes and manages staging**, and was first applied to `c4b0a8-test-rg`
on 2026-08-13. It instantiates every module in `azure/modules/`; the landing zone owns the VNet, so
subnet ids are parameters rather than resources.

That first apply found two defects the template had carried for months, both invisible to
`what-if`:

- `documents` and `boundaries` declared `/id/?` in their Cosmos `indexingPolicy`. Cosmos rejects the
  whole policy — `id` is a system property, always indexed, and cannot be named in a policy — so the
  module could never deploy. `what-if` does not validate indexing rules.
- `main.bicep` did not pass `adminApiKey` or `doclingApiKey` to the API module, so the module's
  `''` defaults would have overwritten `ADMIN_API_KEY` and `DOCLING_API_KEY` in live app settings.
  `what-if` masks `@secure()` values, so it showed nothing.

The second one is the general lesson: **a clean `what-if` is not evidence that an apply is safe.**
It cannot see secure parameters and it does not validate resource-provider rules. Read the diff for
secrets by hand before applying. The credentials that used to be round-tripped through parameters
are vault-only now, so the template has nothing left to blank for those.

It is not a loaded gun, though, and now for two independent reasons. **No dev workflow contains an
infra job at all** — the `deploy-infra` job became a loginless `validate-infra` on 2026-08-04, and
that in turn moved to `pr.yaml` as `validate-bicep` on 2026-08-05 when the deploy workflows were
split. A template that will not compile is a pull-request problem; it has no bearing on whether a
zipdeploy should run, so it no longer blocks one. And the CI identity is scoped to the Flex app
`demi-api-fc-test` plus a data-plane role on one storage account, so it could not run an ARM
deployment even if a job came back. Infrastructure changes go through `az` by hand meanwhile.

Things that will cost you time if you rediscover them:

- **`az functionapp restart` does not recycle the Node worker.** Use `stop` then `start` — and even
  then, poll a discriminator until it flips. A warm worker served the old build after both, for
  minutes.
- **`config-zip` replaces the deployment package whole.** Flex has no `wwwroot` to merge into: each
  deploy uploads a new package to blob storage and the app starts from that package entirely, so
  there is nothing to prune and no stale-file trap. Verify by `BUILD_ID` in `GET /api/config`, then
  confirm the trigger synced by polling `az functionapp function list -g <rg> -n <app>` for `api` —
  that sync runs asynchronously after the package upload succeeds.
- **Never ship `.env`.** App settings supply every variable in Azure.

More in
[Environment Reality & Operational Gotchas](https://github.com/digitalspace/eagle-demi/wiki/Environment-Reality-and-Operational-Gotchas).

### Alerts

Everything below mails one action group, `demi-alerts-<env>`, created in
`azure/modules/observability.bicep`. There is exactly one per environment: `audit-logs.bicep` and
`availability.bicep` are passed its id rather than making their own.

| Resource | Reads | Severity | Fires when |
|---|---|---|---|
| `demi-logs-quota-<env>` | `Usage` | 2 | Billable ingest over 24h passed 80% of the workspace's daily cap |
| `demi-reconcile-drift-<env>` | `AppTraces` | 2 | The nightly reconcile line says `drift=` over 0. Prod only |
| `demi-bulk-download-failed-<env>` | `AppTraces` | 2 | A bulk download job failed after its retries. Test only |
| `demi-chunk-ingest-failures-<env>` | `AppTraces` | 2 | Five or more `chunk write incomplete`, `chunk ingest rejected` or `Chunk ingest failed` lines in an hour |
| `demi-cosmos-ru-<env>` | Cosmos `TotalRequestUnits` metric | 2 | Cosmos used more than `cosmosRuPerHourAlert` RU in the last hour: 3M on test and prod |
| `demi-search-failures-<env>` | `AppTraces` | 1 | Three or more search errors in five minutes: `[search] … failed`, `[search/summary] … failed`, or `[ai-search] … retried without it` |
| `demi-search-5xx-ratio-<env>` | `AppRequests` | 1 | Over 20% of `/search` requests answered 5xx in five minutes, over at least five requests |
| `demi-search-availability-<env>` | `availabilityResults` | 1 | The web test below dropped under 90% over fifteen minutes |
| `demi-audit-drop-<env>` | `AppTraces` | 1 | Audit rows stopped landing — see `audit-logs.bicep` |

The two chunk and Cosmos rules are the answer to a retry loop in September 2026 that held
`demi-cosmos-test` at 4-8M RU an hour, about 70 CAD a day, for five days. The budget alert was the
first to notice, and its cost data lags 24-48 hours. The metric rule checks every fifteen minutes.
Serverless Cosmos in canadacentral lists at 0.3812 CAD per million RU, so 3M RU an hour is about
1.1 CAD an hour. Both environments use 3M: prod's busiest hour in the 30 days to 2026-09-21 was
1.73M RU, test's p99 hour 1.4M, and the loop ran 4-8M. The metric rule lives in `azure/modules/cosmos-alerts.bicep`, not in
`observability.bicep`: Cosmos already depends on observability through the audit workspace, so
passing the Cosmos id back the other way would create a cycle.

The two search rules are the answer to 2026-09-08, when every `dataset=Document` query returned 502
for 65 minutes and the only record of it was a log line nobody was reading. They overlap on purpose:
the trace rule still fires when traffic is too thin for a ratio to mean anything, and the request
rule still fires when the process dies before it can log. Expect both to page on one real outage.

Not every branch the trace rule watches is a 502. `[ai-search] … retried without it` is the
schema-drift degrade: the live index cannot answer a field the deployed build asked for, so the
request drops that field, retries, and is answered 200 with `meta.degraded` — the site stays up and
the page is missing a column. Nothing else notices that, which is why it pages. Each tag is matched
closed, so `[search-schema]`, written by the anonymous `/health/search-schema` probe, cannot raise a
page of its own.

`demi-search-availability-<env>` is the standard web test in `availability.bicep`, deployed only
where `availabilityUrl` is set (both environments today). It GETs the public search URL every five
minutes from five probe locations and requires a 200 whose body contains `searchResultsTotal` — the
key the API attaches only when it actually measured a total, so a 200 that is not really an answer
fails the test.

---

## Releases

**Two workflows, and the tag is cut at test time.** This is the paradigm the other Azure repos are
meant to copy, so the shape matters more than the details:

| | Workflow | Does |
|---|---|---|
| **test** | `draft-release.yaml` + the two `azure-deploy-staging-*.yaml` | Every push to `main` **mints a git tag**, refreshes the single draft release for it, and deploys that push to staging |
| **prod** | `azure-deploy-prod.yaml` | Dispatched with a version, deploys `refs/tags/<version>`, and **publishes that release as its last step** |

**The tag exists before anything is deployed.** That is the change: a draft release mints no git ref,
so under the previous model the build running on staging had no name and "deploy the tag you verified
on staging" could not be obeyed until a human had already published it. Publishing therefore meant
"somebody intends to ship this". Now the tag is minted alongside the draft, the prod workflow deploys
it, and **publishing means the version is in production**. Nothing else publishes — do not click
Publish in the UI.

The cost is deliberate: **a version is spent on every push to `main`**, and tags accumulate for
candidates that never reach prod. A tag is a 40-byte ref, and the payoff is that every staging build
is addressable — including for a rollback, which is just a dispatch naming an older tag.

**Versions are computed, never typed.** `scripts/next-version.js` reads the commit messages between
the **highest existing tag** and the commit being built, then applies conventional-commit rules to
the whole set: a breaking change bumps major, otherwise any `feat` bumps minor, otherwise patch. A
breaking change is `!` before the `:`, or a `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer line in the
body; both spellings are normative and both are honoured. **While the major is `0` a breaking change
bumps the minor instead** — a stray `refactor!:` must not mint `v1.0.0` on a product that has never
shipped to prod.

The base is the highest **tag**, not the latest published release. With a tag per push, a base that
only saw published releases would recompute the same number every push and collide with the tag it
had just created. A side effect worth knowing: ticking *Set as the latest release* on an older
release no longer moves the version base backwards, which used to be a live trap.

The bump range and the **release-notes** range are therefore different, on purpose.
`--generate-notes` infers its own start, which is the last *published* release — the last version
that actually reached production. So the notes on the candidate that ships carry the work of every
candidate that did not, which is the right answer to "what is new in prod".

`draft-release.yaml` maintains **exactly one draft release**, deleting and recreating it each run, so
**any hand-edit to the draft body is lost on the next push**; write release prose in the commits
instead. Deleting a draft never deletes its tag — `gh release delete` is run without `--cleanup-tag`,
and that flag must never be added, since it would destroy the previous candidate's tag on every push.
A tag whose draft has been superseded is still deployable; if prod deploys one, the publish step
creates the published release itself.

Once a first release exists, `git describe --tags` resolves and the deploy script stamps
`BUILD_ID` as `v0.1.1-3-gabc1234-121314`, reported at `GET /api/config`. Before that it is a bare
SHA, exactly as today.

**Before any of this can run, the seed release must exist.** It is created once, by hand, and
deliberately without `--generate-notes` — with no prior release GitHub has no start boundary for
note generation and would emit notes for all ~296 commits in the repository:

```bash
gh release create v0.1.0 --repo digitalspace/eagle-demi \
  --target main --title "v0.1.0" \
  --notes "Baseline: the state of staging as of the first tagged release."
```

Create it **before** this automation lands on `main`, or the first *Tag and draft release* run fails:
the script has no first-run path at all, by design. Every later version is computed against a real
predecessor, which is what removes the untestable "no previous release" branch from the script.
Publishing that seed is what puts the `v0.1.0` tag in place; from there the workflow tags on its own.

`release-drafter` was the closest off-the-shelf fit and was rejected on a specific point: its
`version-resolver` reads **pull-request labels** and its notes are assembled from **merged PRs**.
This repository sometimes pushes straight to `main`, and such a commit carries no PR — it would
affect neither the notes nor the version bump, silently.

---

## Repository security

Enabled 2026-08-05. The repo is **public**, so all of this is free — none of it needs an Advanced
Security licence.

| | |
|---|---|
| Secret scanning | Scans the full history on every branch. Zero alerts |
| **Push protection** | Blocks a push containing a recognised credential, instead of reporting it once it is already public |
| Dependabot alerts + security updates | Opens PRs for advisories; no config needed for that part |
| Code scanning | CodeQL default setup — `actions`, `javascript-typescript`, `python`. No workflow file to maintain |

**Push protection is the enforcement behind "never ship `.env`".** That rule was previously a
convention, and this repository has already shipped a `.env` carrying `MONGODB_PASSWORD`,
`TYPESENSE_API_KEY`, `MINIO_SECRET_KEY` and `DOCLING_API_KEY` into `wwwroot` once.
`scripts/package-api.py` excludes `.env` at every depth; push protection stops it a step earlier, at
the commit. Note it only blocks pattern types with low false-positive rates — it is a backstop, not
a substitute for keeping secrets in app settings.

`secret_scanning_validity_checks`, `non_provider_patterns` and `ai_detection` are deliberately off:
unlike push protection, those sit behind paid Secret Protection.

**Reading the Dependabot count.** The raw number overstates the exposure. Only `frontend/dist` is
deployed, never `frontend/node_modules`, so advisories on the frontend build toolchain are a CI
supply-chain concern and not a production one. The API is the opposite — its package includes
`node_modules`, so a root-lockfile advisory does reach `demi-api-fc-test`. Group by
`dependency.manifest_path` and `dependency.scope` before deciding anything:

```bash
gh api "repos/digitalspace/eagle-demi/dependabot/alerts?state=open&per_page=100" \
  --jq '[.[]|{man:.dependency.manifest_path,scope:.dependency.scope,
              fixable:(.security_vulnerability.first_patched_version!=null)}]
        |group_by(.man+.scope)|map({manifest:.[0].man,scope:.[0].scope,n:length})'
```

Grouping and routine version updates come from `.github/dependabot.yml`. Minor and patch updates
are grouped for each lockfile. Majors arrive one per pull request.

**GitHub Code Quality is not enabled.** It went GA on 2026-07-20 and bills $10 per active committer
per month, counted org-wide, and it is not in the free public-repo set. It is also UI-only, with no
REST API, so it cannot be scripted. CodeQL above provides the same analysis engine at no cost.

---

## Frontend

React app under `frontend/`, built with Vite to `frontend/dist`. Every route requires a Keycloak
session with `staff`, `sysadmin` or `demi-admin`; there is no anonymous screen. Screen list, routes
and backend calls: [[Frontend]] on the wiki.

```bash
cd frontend
yarn dev                  # dev server on :4200, proxies /api and /notify-api (vite.config.ts)
yarn lint && yarn test && yarn build
yarn preview --host 127.0.0.1 &
node scripts/e2e-smoke.mjs   # every screen and old URL against the build, Keycloak off
```

The smoke script needs Playwright where Node can find it, or `PLAYWRIGHT_MODULE` set to its
`index.mjs`. It is not a dependency of the app. It swaps in a Keycloak-off `env.js` and serves every
API call from `parity/fixtures/`, so nothing on disk changes and no API is called.

- **Interactive map explorer** over project coordinates and administrative overlays.
- **Static boundary GeoJSON** — `regional_districts.geojson`, `municipalities.geojson`,
  `electoral_districts.geojson` in `frontend/public/assets/geojson/`, checked in. Regenerate with
  `node scripts/export-topological-boundaries.js`, which uses Mapshaper Visvalingam-Whyatt arc
  simplification so adjacent areas share edges with no slivers or overlaps. These files are also read
  at seed time by `src/seed/sources.js`, and `scripts/package-api.py` hard-fails without them.
- **Deep text search** over extracted document chunks, via Azure AI Search.

---

## Related repositories

- [eagle-api](https://github.com/bcgov/eagle-api) — reads read-only cached project/document entries
- [eagle-demi wiki](https://github.com/digitalspace/eagle-demi/wiki) — architecture, measurements,
  Azure environment, ADRs
