# Serverless prod release: Flex + APIM

Brings prod to the test architecture: Front Door > API Management > Functions Flex Consumption >
Cosmos serverless. Test rollout completed 2026-09-01; prod waits for the soak gate below.

Prod scope is smaller than test: there is no DEMI frontend or admin site in prod, so no Front Door
routes or CSP work. The consumers are eagle-public's `/demi-search` (via the OpenShift rproxy) and
eagle-api's mirror push.

## Gate: soak

At least one week on test from 2026-09-01. Pass means: no unexplained 5xx or failure-rate rise
in `requests` (App Insights), cold starts acceptable through the full chain, timers registered.
Test runs no availability webtest on purpose — a 5-minute probe keeps the app warm and hides
scale-to-zero behaviour; the soak reads passive telemetry and real traffic.

## Pre-flight

1. Pick the release tag: the eagle-demi tag running on test, unchanged.
2. `azure/main.prod.bicepparam` edits, in one commit:
   - delete the `existingServerFarmId` line (Flex is one app per plan; `plan-eagle-search-prod`
     stays with eagle-search-api-prod),
   - `param apiFlexSubnetId` = the `snet-demi-func-fc1-prod` resource id (exists, /27, delegated),
   - `param deployApim = true`,
   - `param budgetStartDate` = the live prod budget's `timePeriod.startDate` month
     (`az rest --method get --url ".../resourceGroups/rg-demi-prod/providers/Microsoft.Consumption/budgets/demi-budget-prod?api-version=2021-10-01"`);
     an existing budget rejects any startDate change.
3. Gateway secret, control plane (data plane is blocked by the private endpoint AND the
   `Enforce-GR-KeyVault` guardrail; control plane bypasses both):

   ```
   SECRET=$(openssl rand -base64 32)
   az rest --method PUT \
     --url "https://management.azure.com/subscriptions/<prod-sub>/resourceGroups/rg-demi-prod/providers/Microsoft.KeyVault/vaults/<prod-vault>/secrets/apim-gateway-secret?api-version=2023-07-01" \
     --body "{\"properties\":{\"value\":\"$SECRET\"}}" -o none
   ```

## Deploy

1. `./scripts/deploy-infra.sh prod` (what-if is the default). Expect ONLY creates: FC1 plan
   `demi-plan-fc-prod`, app `demi-api-fc-prod`, its storage, `demi-apim-prod` and children.
   Anything touching `plan-eagle-search-prod`, `eagle-search-api-prod`, or the existing
   `demi-api-prod` beyond app settings = stop and read.
2. `CONFIRM_PROD=yes ./scripts/deploy-infra.sh prod --live`. If the APIM named value fails 403,
   that is the same-deployment RBAC propagation race — plain rerun succeeds.
3. Deploy the release tag to `demi-api-fc-prod` through the prod workflow's Flex step
   (`gh workflow run "Deploy to Prod" -f version=<tag>`, GH environment approval gate).
4. Mint identity rows against the prod fc host with the prod admin key
   (`POST /api/admin/api-keys`, `id: "apim:eagle-api"` etc., roles per consumer,
   `allowWrite: true` for write roles). No key material is generated for these rows.

## Verify before any traffic moves

- `https://demi-api-fc-prod.azurewebsites.net/api/health` 200; Cosmos/Search reachable over the
  PEs (a real `/api/search` answers).
- `https://demi-apim-prod.azure-api.net/api/health` 200 anonymous.
- `/machine/<auth route>` 401 without a key, 200 with the `eagle-api` subscription key
  (`az apim subscription list-keys`) resolving `demi-service-write`.
- Cold start after 30 min idle recorded.

## Flip

1. `eao-nginx/helm/rproxy/values-prod.yaml` `demi:` origin → `https://demi-apim-prod.azure-api.net`,
   tag, `gh workflow run "Deploy to Prod" -f version=<tag>`; `oc rollout restart deploy/rproxy` in
   `6cdc9e-prod` if config does not roll. eao-nginx flips before anything else, per prod rules.
2. eagle-public prod search in a real browser.
3. eagle-api keeps pushing with `demi-service-write` direct to the fc host — dual-accept, no
   change required at flip time. Moving it to `/machine` + subscription key is a separate
   eagle-api change. The extractor stays direct permanently (APIM's 30 s cap vs NDJSON ingest).

## After one clean week

- `az functionapp stop` old `demi-api-prod` (B1/B3 co-tenant). Delete one week later.
- Phase 5 deletions in eagle-demi: `azure/modules/api-web-app.bicep`, `deploy-azure.sh` api
  target, `RATE_LIMIT_MAX_REQUESTS` params, `vnet.bicep`.
- Revoke old machine keys EXCEPT the extractor's.
- `plan-eagle-search-prod` B3 downsize is a separate saving, owned by eagle-search-api-prod.

## Rollback

Any point before the flip: nothing moved, delete nothing, old app untouched. After the flip:
revert the one `values-prod.yaml` line and redeploy eao-nginx; `az functionapp start demi-api-prod`
if it was stopped. Cosmos and Search are shared by both apps — no data movement either way.
