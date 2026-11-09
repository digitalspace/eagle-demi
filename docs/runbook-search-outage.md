# Runbook: search is down or returns nothing

For the failure that took public Document search down for 65 minutes on 2026-09-08: the app was
deployed with a `$select` naming `fileSize`, the live prod `documents` index had no such field, AI
Search answered 400, and the controller turned that into a 502 for every Document query. The same
shape of failure hits any field the code uses before the index has it — a sort, a filter, a facet.

Neither deploy workflow applies index definitions, so the index and the app can disagree at any
time. This page is the response, in the order to do it.

## Symptom

- eagle-public search returns "Document search is unavailable"; the browser console has nothing
  else. Project search may still work — the two use different indexes.
- Or search returns 200 with zero results, or with a filter that matches nothing. That is the
  quieter half of the same fault: the field exists in the index but every row holds `null`, because
  the data source is still projecting the old column list.

## 1. Name the cause, one curl

```bash
curl -s "https://www.projects.eao.gov.bc.ca/demi-search/search?dataset=Document&pageSize=1"
```

502 is the drift shape. 200 with `searchResultsTotal` above zero means search is up and the problem
is elsewhere.

To have the missing field named for you rather than inferred, there is also a schema health check,
available from the release that includes PR #349. The Function host answers it, not the edge:

```bash
curl -s https://demi-api-fc-prod.azurewebsites.net/health/search-schema
```

`{"ok":true}` means every committed field is in the live index. A 503 names the index and the
missing fields. On an older build the curl answers 404; use the search curl above.

## Fields null on every row

A different fault with the same look. Search works, the page renders, and one column is blank
everywhere — on 2026-09-17 the public project list showed no phase and no decision for all 359
production projects. The `projects` index had `currentPhaseName` and `eacDecision` null on every
row, because production Cosmos held those List references as bare id strings and the data source
projects `c.currentPhaseName.name`. Nothing above finds this: the fields exist in the index, so the
schema probe is green. Ask the data probe instead, which counts the empty rows:

```bash
scripts/search-data-probe.sh https://demi-api-fc-prod.azurewebsites.net
```

The lines name `currentPhaseNameId` and `eacDecisionId` rather than the two fields the page shows.
Those two cannot be filtered on, so the probe counts their `_id` twins, which the data source pulls
off the same object and which go null in the same failure and no other.

A `FAIL` line means eagle-api pushed those projects before its List references were resolved. Fix it
at the source — re-push from the eagle-api pod, then wait one `PT5M` indexer tick and run the probe
again:

```bash
LOG_LEVEL=info node scripts/demi-repush.js --kinds project --concurrency 1 --ids-file <file> --live
```

`<file>` holds the project `_id`s to re-push, one per line. A live project run refuses to start
without it.

Do not reset the indexer for this. The rows in Cosmos are wrong; re-indexing them changes nothing.
The checks and how to add one: `azure/search/README.md`, "Data checks".

## 2. Read the 502 body

A search 502 carries a `code`, and sometimes a `traceId`:

| `code` | Meaning | Next step |
|---|---|---|
| `SEARCH_SCHEMA_DRIFT` | The live index cannot answer a field the app asks for. The body's `field` names it. | Go to step 3 |
| `SEARCH_UPSTREAM` | The service did not answer: a role, a timeout, a Cosmos fault. | Not this runbook. Check the identity's role assignment and Cosmos health. |

The body never carries the upstream error text, because it can hold the index name and the caller's
OData filter. The text is in Log Analytics (`demi-logs-prod`, `demi-logs-test`):

```kusto
AppTraces
| where Message startswith "[search]" and Message has "failed"
| project TimeGenerated, Message, Properties
| order by TimeGenerated desc
```

`Could not find a property named '<field>'` is schema drift and this page fixes it. Anything else —
throttling, timeouts, 403 — is not, and the fix here will not help. The `traceId` in the body is the
request id that every log line for that request carries.

## 3. Confirm the drift

Read-only. Exits 1 when a committed field is missing from the live index:

```bash
scripts/demi-devbox.sh drift --env prod     # or --env test
```

It runs `apply-search-definitions.js --check` on the devbox under a temporary Search Service
Contributor grant, and revokes the grant afterwards. One run-command call, however many indexes
`--only` names. The comparison is against the definitions in
the devbox checkout, which tracks `main` — if prod is running an older tag, that is still the right
comparison, because the index has to satisfy whatever is deployed next as well.

## 4. Fix it

The primary path is the API: `POST /api/admin/search-definitions/apply` with
`{"only":["documents"],"live":true}` runs the apply inside the Function app and answers a job id to
poll at `GET /api/admin/search-definitions/jobs/{id}` (README, "Applying definitions through the
API"). It still needs the temporary Search Service Contributor grant, and it does the same steps in
the same order. Use the devbox commands below as break-glass — when the Function app itself is the
thing that is broken, when its queue is not configured, or when you need a shell for something the
route does not do.

```bash
scripts/demi-devbox.sh apply --env prod --only documents
```

`--only` keeps the run to one index and its indexer. It dry-runs first, prints what it would write,
and asks before writing. It takes the subscription, service, indexer identity and devbox VM from the
`--env` it is given, so a prod run cannot inherit test values:

| | test | prod |
|---|---|---|
| `SUBSCRIPTION` | `7897ceb1-9a86-4639-87d7-7f9ff67142b3` | `be5924ac-1083-4a1b-be92-7b444882cfd9` |
| `RG` | `c4b0a8-test-rg` | `rg-demi-prod` |
| `SERVICE` | `demi-search-test` | `demi-search-prod` |
| `IDENTITY` | `demi-identity-test` | `demi-identity-prod` |
| Devbox VM | `demi-devbox-test` | `demi-devbox-prod` |

The script reads `RG` with `az` from the search service and the VM, not from a constant, so a
service and a devbox in different groups both resolve.

The script works in this order, because any other order either takes the site down or fills the
index with nulls:

1. **PUT the index and its indexer.** Adding a field is supported in place; a drop, a retype or a
   changed analyzer is a rebuild and the script refuses it. A refusal here means the change is not a
   widening — go to `azure/search/README.md`, "Restoring one", and do it by hand.
2. **PUT the data source**, if its committed `SELECT` differs from the live one. Without this the
   indexer keeps projecting the old columns, the new field stays `null` on every row, and nothing
   reports an error. Only the data sources that differ are written.
3. **Reset and run that indexer**, and wait for the run to finish. A schema-only change re-pulls
   nothing on its own, because the high-water mark is `_ts`, so the reset is what fills the new
   column. The script then guards the reset in four ways:

   - It refuses to reset while an execution is in progress. A `PT5M` tick that finishes after the
     reset writes its old high-water mark back and silently undoes it.
   - It waits for any execution that straddled the reset to drain before asking for a run. This stops
     a run finishing with `items=0`.
   - A 409 on the run POST means a run is already going. The script keeps that run when it started
     after the reset, and otherwise lets it drain and posts again.
   - It waits 5 seconds before the run, because the service applies a reset in its own time. It
     reads `initialTrackingState` of the finished execution, and if the run still started from the
     old high-water mark it resets again and waits longer.

   The script makes up to three attempts (two retries, waiting 20 s then 40 s before the run) and
   logs `DEMI_RESET_RETRY` before each retry. After the third failed attempt it logs
   `DEMI_RESET_NOT_APPLIED` and exits 1.

Steps 1 and 2 travel in one run-command call, step 3 in another, so an apply is three or four calls
in total rather than one per index plus one per poll. The whole wait for step 3 happens on the
devbox; what comes back is a `DEMI_RESULT` line per indexer with its row counts.

Then re-run step 1's curl. `documents-indexer` reports around 61,500 rows processed when it has done
its job; `projects-indexer` around 393. `chunks-indexer` is hours and about 1.1M rows — do not reset
it to fix a metadata index.

`INDEXER_TIMEOUT` (default 1800 s) bounds the wait. An indexer still running at the deadline is a
warning, not a failure: the script prints `DEMI_WARN … still running` and exits 0, because the run was
posted and is working. Re-read it with `watch`.

A run that ends with a `Failure` status prints `DEMI_FAIL` and exits non-zero.

`chunks-indexer` waits up to `INDEXER_TIMEOUT_LONG` (default 4800 s), because a run-command is cut
off at 90 minutes, both through `az vm run-command invoke` (the default) and as a managed run command
under the role grant (`DEVBOX_RUN_MODE=managed`). A chunks reset therefore skips the wait with
`--no-wait`, and `watch` resumes the wait against the same indexer without a second reset:

```bash
scripts/demi-devbox.sh apply --env prod --only chunks --datasources demi-chunks-ds --no-wait
scripts/demi-devbox.sh watch --env prod --datasources demi-chunks-ds
```

Prerequisites, if the script stops early:

- `az login --tenant <tenant id> --scope "https://graph.microsoft.com//.default"` when it reports
  that this login cannot read role assignments. An expired Graph token does not fail the grant
  loudly; it fails the command on the devbox as a 403 an hour later.
- The devbox VM must exist in the environment. `demi-devbox-prod` is started by the script and
  should be deallocated afterwards (`az vm deallocate -g rg-demi-prod -n demi-devbox-prod`).

## 5. Or roll back

Faster than a fix when the previous release was healthy, and it is the right move if the index
change is a rebuild rather than a widening. Deploy the last known-good tag with the prod workflow —
deploy source is always a tag, never a branch:

```bash
gh release list -R digitalspace/eagle-demi --limit 5
gh workflow run "Deploy DEMI to Azure production" -R digitalspace/eagle-demi -f version=<tag>
```

The prod workflow also rolls back by itself. Its `rollback` job runs when `deploy-api` fails after
publishing, whether the smoke test failed or the app never came up. It redeploys the newest
published release other than the one just deployed.

A warm-up curl before the smoke test stops a slow Flex cold start from causing a false rollback. The
workflow is described on the wiki page `CI-Deploy-Workflows`.

Rolling back the app does not roll back an index that has already been widened, and it does not have
to: a wider index serves a narrower `$select` perfectly well.

## 6. Break-glass: skip a broken probe

Use this only when the deploy gate cannot answer, not when the schema drifted. The case is
`/health/search-schema` or `/health/search-data` returning 500 on the app serving production.

| Probe answer | Meaning | Action |
|---|---|---|
| 500 | The probe itself is broken. | Break-glass below. |
| 404 | First deploy after the endpoint shipped. | Tick `allow_missing_schema_probe`. |
| 503 | Real drift. | Go to step 3. |

First confirm the tag does not widen the index. The bypass skips the check that would catch it, and
`drift` compares against `main` on the devbox checkout, not against the tag being deployed. The check
holds only when `main` already contains that tag:

```bash
scripts/demi-devbox.sh drift --env prod
```

Exit 0 means `main`'s index definitions match or are narrower than the live index. Only then
dispatch the deploy with the probe skipped. Use a tag at or after `v0.114.4`, the first with the
`skip_schema_probe` input:

```bash
gh workflow run azure-deploy-prod.yaml -R digitalspace/eagle-demi --ref <tag> \
  -f version=<tag> -f skip_schema_probe=true
```

The run logs a warning naming the dispatcher and the tag, then deploys normally. The input skips both
the schema probe and the data probe, not the risk they guard against, so treat every use as an
incident. If it is used often, fix the probe endpoint instead.

Run the Document and Project search queries from the deploy's smoke test by hand, because the data
probe is skipped too. Confirm both return results, not just 200:

```bash
curl -s "https://www.projects.eao.gov.bc.ca/demi-search/search?dataset=Document&pageNum=0&pageSize=1"
curl -s "https://www.projects.eao.gov.bc.ca/demi-search/search?dataset=Project&pageNum=0&pageSize=1"
```

`searchResultsTotal` must be above zero in each.

## Afterwards

- Run `scripts/demi-devbox.sh drift --env prod` as the last step of every prod release, and after
  any deploy that touches `azure/search/` or search code. It is one call and takes under a minute.
  The release steps are on the wiki page `Release-Process`.
- Three alerts page on this outage from different angles, all to the same action group:

  | Alert | Fires when |
  |---|---|
  | `demi-search-failures-<env>` | Three or more search error trace lines in five minutes: `[search]` or `[search/summary]` `… failed`, `[ai-search] … retried without it`, or a top-level `[demi-api search]` error. |
  | `demi-search-5xx-ratio-<env>` | Over 20% of `/search`, `/search/counts` and `/search/summary` requests answer 5xx in five minutes, over at least five requests. |
  | `demi-search-availability-<env>` | The public web test passes under 90% over fifteen minutes. |

- Field-by-field background, and every hand recipe this script wraps: `azure/search/README.md`.
