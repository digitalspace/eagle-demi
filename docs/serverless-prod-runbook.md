# Serverless prod release: Flex + APIM

Brings prod to the test architecture: Front Door > API Management > Functions Flex Consumption >
Cosmos serverless. Test rollout completed 2026-09-01.

Prod scope is smaller than test: there is no DEMI frontend or admin site in prod, so no Front Door
routes or CSP work. The consumers are eagle-public's `/demi-search` (via the OpenShift rproxy) and
eagle-api's mirror push.

## Gate: none — prod is the canary

Test carries near-zero traffic, so a test soak measures nothing. Prod ships behind a
minutes-grade rollback (one rproxy line + the untouched old app) and the search kill switch
(`SEARCH_API_PATH: ''`); the first days after the flip ARE the soak — watch prod `requests`
and the reconcile drift alert.

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
3. eagle-api pushes to the OLD `demi-api-prod` host and keeps doing so at flip time — both apps
   share Cosmos, so nothing breaks. Its `DEMI_API_BASE` MUST move to `demi-api-fc-prod` before
   the old app stops (decommission list). Moving it to `/machine` + subscription key is a
   separate eagle-api change. The extractor stays direct to the fc host permanently (APIM's
   30 s cap vs NDJSON ingest).

## After one clean week

- FIRST: eagle-api `DEMI_API_BASE` → `https://demi-api-fc-prod.azurewebsites.net` (helm values,
  6cdc9e-prod) and one mirror write verified. THEN `az functionapp stop` old `demi-api-prod`.
  Delete one week later — but the old apps' containers are also the only documented SSH-tunnel
  path to the Cosmos/Search data planes (Flex has no SSH); keep one stopped app per env as the
  startable jump box, or build a replacement first.
- Phase 5 deletions in eagle-demi: `azure/modules/api-web-app.bicep`, `deploy-azure.sh` api
  target, `RATE_LIMIT_MAX_REQUESTS` params, `vnet.bicep`.
- Revoke old machine keys EXCEPT the extractor's.
- `plan-eagle-search-prod` B3 downsize is a separate saving, owned by eagle-search-api-prod.

## Rollback

Any point before the flip: nothing moved, delete nothing, old app untouched. After the flip:
revert the one `values-prod.yaml` line and redeploy eao-nginx; `az functionapp start demi-api-prod`
if it was stopped. Cosmos and Search are shared by both apps — no data movement either way.
