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
curl -s https://www.projects.eao.gov.bc.ca/demi-search/health/search-schema
```

`{"ok":true}` means every committed field is in the live index. A 503 names the index and the
missing fields. A 404 means the deployed build predates that endpoint — use the query itself:

```bash
curl -s "https://www.projects.eao.gov.bc.ca/demi-search/search?dataset=Document&pageSize=1"
```

502 is the drift shape. 200 with `searchResultsTotal` above zero means search is up and the problem
is elsewhere.

## 2. Read the real error

The public body is deliberately generic; the upstream text is in Log Analytics
(`demi-logs-prod`, `demi-logs-test`):

```kusto
AppTraces
| where Message startswith "[search]" and Message has "failed"
| project TimeGenerated, Message, Properties
| order by TimeGenerated desc
```

`Could not find a property named '<field>'` is schema drift and this page fixes it. Anything else —
throttling, timeouts, 403 — is not, and the fix here will not help.

## 3. Confirm the drift

Read-only. Exits 1 when a committed field is missing from the live index:

```bash
scripts/demi-devbox.sh drift --env prod     # or --env test
```

It runs `apply-search-definitions.js --check` on the devbox under a temporary Search Service
Contributor grant, and revokes the grant afterwards. The comparison is against the definitions in
the devbox checkout, which tracks `main` — if prod is running an older tag, that is still the right
comparison, because the index has to satisfy whatever is deployed next as well.

## 4. Fix it

```bash
scripts/demi-devbox.sh apply --env prod --only documents
```

`--only` keeps the run to one index and its indexer. It dry-runs first, prints what it would write,
and asks before writing. What it then does, in this order, because any other order either takes the
site down or fills the index with nulls:

1. **PUT the index and its indexer.** Adding a field is supported in place; a drop, a retype or a
   changed analyzer is a rebuild and the script refuses it. A refusal here means the change is not a
   widening — go to `azure/search/README.md`, "Restoring one", and do it by hand.
2. **PUT the data source**, if its committed `SELECT` differs from the live one. Without this the
   indexer keeps projecting the old columns, the new field stays `null` on every row, and nothing
   reports an error. Only the data sources that differ are written.
3. **Reset and run that indexer**, and wait for the run to finish. A schema-only change re-pulls
   nothing on its own — the high-water mark is `_ts` — so the reset is what fills the new column.
   The script refuses to reset while an execution is in progress: a `PT5M` tick that finishes after
   the reset writes its old high-water mark back and silently undoes it.

Then re-run step 1's curl. `documents-indexer` reports around 61,500 rows processed when it has done
its job; `projects-indexer` around 393. `chunks-indexer` is hours and about 1.1M rows — do not reset
it to fix a metadata index.

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
gh workflow run "Deploy DEMI to Azure production" -R digitalspace/eagle-demi -f version=v0.77.1
```

Rolling back the app does not roll back an index that has already been widened, and it does not have
to: a wider index serves a narrower `$select` perfectly well.

## Afterwards

- Run `scripts/demi-devbox.sh drift --env prod` as the last step of every prod release, and after
  any deploy that touches `azure/search/` or search code.
- Field-by-field background, and every hand recipe this script wraps: `azure/search/README.md`.
