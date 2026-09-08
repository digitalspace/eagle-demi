# CI guards on the search schema

On 2026-09-08 a production release selected a document field (`fileSize`) that the live AI Search
`documents` index did not have. Every Document query answered 502 for 65 minutes. The deploy was
green, `/health` was green, and nothing in CI could have known: the code and the committed index
definitions agreed with each other, and the live index was the one that disagreed.

Live indexes are widened by hand — `scripts/demi-devbox.sh apply --env <env>` — because no CI
identity holds Search Service Contributor. So these guards check, they do not fix.

## Three checks

**Before a production deploy.** `verify-search-schema` in `azure-deploy-prod.yaml` checks out the
tag being deployed, builds a probe body from that tag's `azure/search/indexes/*.json`, and POSTs it
to the API that is currently serving production (`scripts/search-schema-probe.sh`). The endpoint
`/health/search-schema` — it arrives with PR #349 — runs each select and orderby against the live
index with `top: 0` and answers 503 naming the missing fields. A 503 stops the release before
`deploy-api` runs.

A 404 also stops it: an endpoint that is not there checked nothing, and the release would go out on
the same evidence the 2026-09-08 one had. The exception is the single deploy that first carries the
endpoint into an environment, where the app already running is necessarily older. Tick the
`allow_missing_schema_probe` input on that one dispatch — it sets `SEARCH_SCHEMA_ALLOW_MISSING=1`
for the probe, and the log says the release shipped ungated. Any later 404 means the deployed app
lost the route.

**After a deploy.** `scripts/search-smoke.sh` asks three real queries: Document, Project, and
Document filtered by a project. Each must answer 200, and the two unfiltered ones must report
`searchResultsTotal > 0`. The filtered one may legitimately match nothing, so only its status
counts. In production a failure here rolls back: the `rollback` job redeploys the newest published
release that is not the one just deployed, through the same composite action the forward deploy
uses (`.github/actions/deploy-api-flex`), re-runs the smoke test, and leaves the run red with the
release unpublished. Staging runs the same smoke test with no rollback — test is where a bad build
is supposed to stop.

**On a pull request.** `search-schema-change` in `pr.yaml` fires when the diff touches
`azure/search/**`, or when `scripts/search-select-changed.sh` reports that the branch selects
different fields than its base. That script compares the VALUES of `DOCUMENT_SELECT`,
`PROJECT_SELECT` and `CHUNK_SELECT`, because each is a multi-line concatenation: the field that
took production down on 2026-09-08 was added on a continuation line, which no grep for `_SELECT`
can see. The PR gate never sets `SEARCH_SCHEMA_ALLOW_MISSING` — test runs `main`, so a 404 there is
the endpoint regressing.

The job probes the test API with the branch's index definitions and requires the PR description to
carry a line:

```
Search-Schema: applied test
```

That line is the author's statement that they ran `scripts/demi-devbox.sh apply --env test` before
asking for review. Production is still widened by hand at release time; the pre-deploy gate above
is what makes forgetting it visible.

## Settings

| Name | Where | Default |
| --- | --- | --- |
| `SEARCH_SMOKE_PROJECT_ID` | repository or environment variable | `5e31dc4462cdea0021d974b4` (Fording River Extension, Castle) |
| `DEMI_ENV` | env var read by the probe script | `prod`; only names the environment in the "widen it with" hint |
| `SEARCH_SCHEMA_ALLOW_MISSING` | env var read by the probe script; the prod workflow's `allow_missing_schema_probe` input sets it | unset — a 404 fails |

Both smoke targets are the Function App's own host, not `www.projects.eao.gov.bc.ca/demi-search`:
the public path also depends on the OpenShift rproxy, which these workflows do not deploy.

## Running them by hand

```
scripts/search-schema-probe.sh https://demi-api-fc-prod.azurewebsites.net
scripts/search-smoke.sh https://demi-api-fc-prod.azurewebsites.net
scripts/search-select-changed.sh main
```

All three print their contract with `--help`. Tests: `test/scripts/search-schema-probe.test.js` and
`test/scripts/search-smoke.test.js` drive the two HTTP scripts against a stub server;
`test/scripts/search-select-changed.test.js` drives the third against a throwaway git repository.

Runbook for an outage in progress: `eagle-demi.wiki/Runbook-Search-Outage.md`.
