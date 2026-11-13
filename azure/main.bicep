// Root template for one DEMI environment. Never deployed by CI. The VNet belongs to the landing
// zone in another resource group, so no VNet is declared here and subnet ids are parameters.

targetScope = 'resourceGroup'

import { intakeContainers } from './modules/document-intake.bicep'

@description('Target Azure region')
param location string = 'canadacentral'

@description('Environment name (e.g. dev, test, prod)')
param environmentName string = 'dev'

@description('OpenShift MinIO Endpoint URL')
param minioHost string = 'minio-6cdc9e-dev.apps.silver.devops.gov.bc.ca'

// No credential parameters: what-if masks a @secure() value before and after, so a deploy could
// blank one unseen. Credentials live in the vault, read by reference; see modules/key-vault.bicep.

@description('Upstream eagle-api the seed loader reads. Environment-specific — the code default is the DEV instance, so this must be set per environment or staging silently reads dev data.')
param eagleApiBase string

@description('Public origin short links redirect from, e.g. https://projects.eao.gov.bc.ca. Per environment: test must not hand back the prod host.')
param linkBaseUrl string = ''

@description('eagle-notify base URL DEMI announces published Updates to. Empty leaves the push dark.')
param notifyApiBase string = ''

@description('Update emails link eagle-public\'s /updates/<id> reader page instead of the project page. Only the React line serves that route: keep false while linkBaseUrl serves the Angular site.')
param notifyUpdateReaderLinks bool = false

@description('Sorts on an Update\'s publishDate run on dateAdded. Set false once src/scripts/backfill-update-publish-date.js reports undated=0 in a dry run.')
param updatesPublishDateFallback bool = true

@description('NCRONTAB schedule for the scheduled-Update announce timer. Empty means every 5 minutes wherever notifyApiBase is set, and no timer where it is not.')
param announceUpdatesSchedule string = ''

// Declared here so a template deploy cannot reset them to the module defaults.
@description('Object-store bucket name (dev: asnpnn, test: zdspnb).')
param minioBucketName string = 'eagle-demi'

@description('Key prefix namespacing this environment inside the bucket.')
param minioKeyPrefix string = ''

@description('Pinned first day of the live budget period — an existing budget rejects startDate changes, so this must match what is deployed. Empty = first of the current month (new budgets only).')
param budgetStartDate string = ''

@description('Monthly anomaly guard in CAD — the subscription\'s billing currency. Sized above the measured run rate of ~350 CAD/month (Cost Management, 2026-08-17); the old 150 came from a 12-day average taken before the resource group had finished billing. The absolute annual ceiling is a separate parameter; see cost-budget.bicep for why one number cannot be both.')
param budgetAmount int = 400


@description('Notification Email Addresses for Cost Alerts')
param contactEmails array = [
  'Daniel.T.Truong@gov.bc.ca'
]

// Empty skips private endpoints and VNet integration, which only suits a scratch deploy: policy
// denies public access here, so an account without its private endpoint is unreachable.
@description('Existing landing-zone subnet for inbound private endpoints (c4b0a8-dev-networking).')
param privateEndpointSubnetId string = ''

@description('Object ID of a human principal granted read access to data planes. Empty grants none.')
param readerPrincipalId string = ''

// An array because a cutover has two hosts: list both, or the new origin is CORS-blocked. Empty
// fails closed: CORS_ORIGIN is unset and src/http/router.js allows only http://localhost:4200.
@description('Frontend hostnames (no scheme) allowed as browser origins against the API. Filled in after the AFD deployment in eagle-search — the hostname carries a deploy-time hash and cannot be guessed.')
param frontendHostNames array = []

@description('Principal id of the CI identity (demi-cicd-<env>) that publishes the frontend bundle into $web. Empty skips the role assignment, and the publish step then gets a 403.')
param frontendUploaderPrincipalId string = ''

// The `$web` origin for DEMI's own frontend. Prod does not have one — eagle-public is the
// consumer there — so a prod deploy would otherwise create a storage account nothing ever publishes to.
@description('Deploy the frontend static-site storage account.')
param deployStaticSite bool = true

@description('Keycloak client whose tokens the API accepts.')
param keycloakClientId string = 'eagle-admin-console'

// No default: an unset value must fail the build rather than deploy a blank. An empty string
// deployed to test or prod is an allowlist that admits every client in the realm.
@description('Comma-separated Keycloak client ids (token azp) permitted to call this API.')
param allowedClients string

// Empty refuses every writer, so blanking it closes the Eagle mirror.
@description('Comma-separated registry row ids permitted on PUT /eagle/*.')
param eagleMirrorPrincipals string = 'apim:eagle-api'

// Empty refuses everyone, so the PDF title routes stay shut until a worker key is named. Never
// list a principal here that is also in eagleMirrorPrincipals: one key would hold both powers.
@description('Comma-separated registry row ids permitted on the PDF title worker routes.')
param pdfTitleWorkerPrincipals string = ''

// Empty keeps the API's backup gate closed, so every PDF title lease is refused. Set it only where
// the document-backup account exists and holds the originals in Archive tier.
@description('Backup storage account the PDF title writes are checked against. Empty keeps the gate closed.')
param backupAccountName string = ''

@description('Container in backupAccountName holding the backed-up originals.')
param backupContainerName string = 'originals'

// Empty, not 'account': the audience Keycloak actually mints is unmeasured, and a wrong value
// rejects every token. Empty means the check is not enforced.
@description('Expected JWT aud claim. Empty disables audience verification.')
param ssoAudience string = ''

// Empty by default. Set it only for a proxy we run in front of APIM, using the address APIM
// reports for it; otherwise the APIM-asserted address is the caller key.
@description('Comma-separated egress IPs of proxies we run. An APIM-asserted address on this list makes the browser hop of X-Forwarded-For the caller.')
param trustedProxyIps string = ''

// Off by default: `log` first to list who still skips Front Door, `enforce` once that list is known.
@description('EDGE_GATE on the API: empty off, log, or enforce (403 for requests that skipped Front Door).')
@allowed(['', 'log', 'enforce'])
param edgeGate string = ''

@description('EDGE_BAN_MODE for the edgeBan timer: off clears the Front Door ban rule, shadow records would-bans, write records and updates the rule.')
@allowed(['off', 'shadow', 'write'])
param edgeBanMode string = 'off'

@description('NCRONTAB schedule for the edgeBan timer, six fields.')
param edgeBanSchedule string = '0 0 * * * *'

@description('Log Analytics workspace holding the Front Door access log (eagle-edge resource group). Empty skips every edgeBan tick.')
param edgeLogWorkspaceId string = ''

@description('Resource id of the eagle-edge `rulesdemidocs/banauto` rule. Empty skips every edgeBan tick.')
param edgeBanRuleId string = ''

// The template cannot see the vault, so naming a secret here states that it exists. An unnamed one
// leaves its app setting empty rather than pointing at nothing.
@description('Optional Key Vault secret names this environment holds: notify-api-key, edge-secret, access-gate-password, pdf-title-worker-api-key, edge-ban-policy.')
param optionalSecretNames array = []

// The OpenShift namespaces the secret sync writes to. Empty deploys no sync app — which is what an
// environment whose vault holds no OpenShift copies wants.
@description('OpenShift namespaces the secret sync owns, e.g. 6cdc9e-dev,6cdc9e-test. Empty deploys no sync app.')
param syncNamespaces string = ''

// False where OpenShift is unreachable: the prod spoke has no route table and policy forbids one,
// so a prod sync app would fail every run.
@description('Deploy the OpenShift secret sync app. False leaves that environment\'s OpenShift secrets to be set by hand.')
param deploySecretSync bool = true

@description('ROTATED_SECRETS for the rotator: comma list of name:stamper:probe, stamper frontdoor or apim, probe demi-edge, demi-gateway, analytics or none.')
param rotatorTargets string = ''

@description('RENEW for the rotator: extend the expiry of every other enabled secret before it lapses.')
param rotatorRenew bool = false

@description('EDGE_RULE_IDS for the rotator: comma list of the eagle-edge stampedgesecret rule ids.')
param rotatorEdgeRuleIds string = ''

@description('PROBE_DEMI_URL for the rotator: DEMI /health/trust through Front Door.')
param rotatorProbeDemiUrl string = ''

@description('PROBE_ANALYTICS_URL for the rotator: analytics /events through Front Door.')
param rotatorProbeAnalyticsUrl string = ''

@description('ISSUER_EXPIRY for the rotator: comma list of name=YYYY-MM-DD for issuer-owned secrets.')
param rotatorIssuerExpiry string = ''

// Deploys only where `pdf-title-worker-api-key` is also in optionalSecretNames, so the vault is
// known to hold the key the app setting references.
@description('Deploy the PDF title worker app. Needs pdf-title-worker-api-key in optionalSecretNames.')
param deployPdfTitleWorker bool = false

@description('True lets the PDF title worker write; false lists its work and writes nothing.')
param pdfTitleLive bool = false

@description('Rows the PDF title worker takes from its work list per run.')
param pdfTitleMaxRows int = 20

// Under the schedule's 10 minutes, so runs do not overlap.
@description('Minutes after which a PDF title run starts no new row.')
param pdfTitleMaxMinutes int = 5

@description('NCRONTAB schedule of the PDF title worker timer.')
param pdfTitleSchedule string = '0 */10 * * * *'

// Flex needs its own subnet, delegated to `Microsoft.App/environments`. Empty deploys no API app
// at all, so an environment that wants one must supply it.
@description('Delegated subnet for the Flex Consumption API app. Empty deploys no API.')
param apiFlexSubnetId string = ''

// Turning this on also needs `Storage Blob Delegator` on the identity, which `Storage Blob Data
// Contributor` does not imply; without it every download link fails to sign.
@description('Deploy the Phase 3b document storage account. Off: dev still reads MinIO.')
param deployDocumentStorage bool = false

@description('Deploy the document intake staging account, the only account Defender for Storage scans.')
param deployDocumentIntake bool = false

@description('Defender malware scanning cap on the intake account, GB per month')
@minValue(1)
param intakeCapGBPerMonth int = 5

@description('Comma-separated `sources` keys a project may publish over HTTP. Empty publishes none.')
param enrichmentSources string = ''

// Declares the container; `enrichmentSources` decides what the API publishes. `boundaries` is
// reference data, declared everywhere; see cosmos-nosql.bicep.
@description('Declare the Cosmos wildfires container.')
param deployEnrichment bool = true

// Prod's search service is deployed from azure/ai-search.prod.bicepparam, not here; a re-PUT from
// here would overwrite its `semanticSearch` and identity list.
@description('Deploy the AI Search service. False consumes `existingSearchEndpoint` and grants Search Index Data Contributor on the service already standing.')
param deploySearch bool = true

@description('Endpoint of an already-deployed search service, used when `deploySearch` is false.')
param existingSearchEndpoint string = ''

// An already-standing service runs its indexers as its own identity, not ours, so the Cosmos grant
// the ai-search path gets for free (same UAMI as the API) has to be made explicitly here.
@description('Principal of the identity the existing search service runs its indexers as. Used only when `deploySearch` is false; grants it Cosmos Data Reader.')
param existingSearchIndexerPrincipalId string = ''

@description('Resource id of that same identity. Used only when `deploySearch` is false: a data source PUT names the identity by resource id, not principal.')
param existingSearchIndexerIdentityId string = ''

// Set in `main.<env>.bicepparam`, never by hand: `appSettings` is a whole-collection PUT, so a
// hand-set value dies on the next deploy.
@description('Azure AI Search index holding recent activity. Empty falls back to Cosmos.')
param searchIndexActivities string = ''

@description('Azure AI Search index holding project notifications. Empty falls back to Cosmos.')
param searchIndexProjectNotifications string = ''

// Unlike `summaryEnabled`, which is the app-side switch, this decides whether the Foundry ACCOUNT
// is created. Prod runs no summariser, so it should have no model resource to attribute or secure.
@description('Deploy the Foundry account and model deployment. False leaves FOUNDRY_ENDPOINT empty, which is the same state summaryEnabled=false already produces.')
param deployFoundry bool = true

// Foundry bills per token, so an idle account is free; `GET /api/search/summary` is privileged-only
// to bound that cost. False makes it answer `{summary: null, reason: 'disabled'}`.
@description('Turn the AI summariser on. The Foundry account is deployed regardless; this is the app-side switch.')
param summaryEnabled bool = true

// The PE PUT always fails with AccountProvisioningStateInvalid while the account sits in `Accepted`.
// Set false once the PE exists and is Approved; a fresh environment pays one failed run.
@description('Create the Foundry private endpoint. Set false when it already exists — re-PUTting it races the account PUT and fails the whole deployment.')
param deployFoundryPrivateEndpoint bool = true

// Nightly Eagle drift report (api/index.js). Set both this and the alert: an alert with no run is
// silent, a run with no alert is a log line nobody reads.
@description('NCRONTAB schedule for the Eagle reconcile timer, e.g. `0 0 9 * * *`. Empty runs it never.')
param reconcileSchedule string = ''

@description('Deploy the log alert that fires when that run reports drift.')
param deployReconcileDriftAlert bool = false

// Nightly Track team sync (api/index.js), which mints `project:<id>` realm roles from Track team
// members. The schedule is the switch: empty registers no timer.
@description('Base URL of the Track API the team sync reads, e.g. https://epictrack-api-c8b80a-test.apps.gold.devops.gov.bc.ca. Empty runs no sync.')
param trackApiBase string = ''

@description('Keycloak client id of the Track service account (client credentials).')
param trackClientId string = ''

@description('Mirror every public Track work type and its milestones (`works[]`) in the nightly sync. Off until the public read ships.')
param trackWorksSync bool = false

@description('Write every Track work into the `works` container in the nightly sync, beside the project row arrays. Off until test has proven it.')
param worksWrite bool = false

@description('Compose project works from the `works` container instead of the project row. Off until the parity check passes.')
param worksRead bool = false

@description('Sources whose works a read keeps: a comma list of track, sheet and demi. Any other token stops the app.')
param worksReadSources string = 'track'

@description('Date the assessments of every project from its documents, comment periods and Track phases in the nightly sync. Off until test has proven it.')
param assessmentPass bool = false

// The Track and role-sync client secrets are vault-only: `track-client-secret` and
// `role-sync-client-secret`, resolved by reference.
@description('Keycloak client id of the realm-management service account the sync grants roles with.')
param roleSyncClientId string = ''

@description('NCRONTAB schedule for the Track team sync timer, e.g. `0 0 10 * * *`. Empty runs it never.')
param syncTeamsSchedule string = ''

@description('NCRONTAB schedule for the Track project poll timer, e.g. `0 */5 * * * *`. Empty runs it never.')
param syncProjectsSchedule string = ''

// Bulk download. The switches default off, so an environment gets the queue and container without
// the feature running. A .bicepparam sets a cap only to override it.
@description('Storage queue the bulk-download worker triggers on, e.g. `bulk-downloads`. Empty runs no worker.')
param bulkDownloadsQueue string = ''

@description('NCRONTAB schedule for the zip cleanup timer, e.g. `0 30 3 * * *`. Empty runs it never.')
param bulkCleanupSchedule string = ''

// Off means skipped: the inline walk is a local-development opt-in (CHUNK_RESTAMP_INLINE), never a
// fallback a deployed environment reaches by losing a setting.
@description('Storage queue the chunk parent-field re-stamp worker triggers on, e.g. `chunk-restamp`. Empty skips the re-stamp and flags the document `parentFieldsPending` — it does NOT patch inline; repair with backfill-chunk-parent-fields.js --pending.')
param chunkRestampQueue string = ''

@description('Storage queue the search definition apply worker triggers on, e.g. `search-definitions`. Empty answers POST /admin/search-definitions/apply with 503, and the devbox recipe in docs/runbook-search-outage.md is the way through.')
param searchDefinitionsQueue string = ''

// Sync-out: DEMI-owned comment periods sent on to eagle-api. The client secret is the vault's
// optional `eagle-sync-out-client-secret`, not a parameter.
@description('Storage queue the sync-out worker triggers on, e.g. `sync-out`. Empty runs no worker and deploys no queue.')
param syncOutQueue string = ''

@description('Turn on the Eagle consumer of the sync-out queue. Off until the cutover.')
param syncOutEagleEnabled bool = false

@description('Also send comment periods created in DEMI. Turn on only when eagle-api\'s POST honours the `_id` DEMI sends and answers a duplicate `_id` with 409.')
param syncOutEagleNativeEnabled bool = false

@description('Also send document edits and level changes to eagle-api, for documents that already hold an Eagle id. Off until the document cutover.')
param syncOutEagleDocumentEnabled bool = false

@description('Also send organizations written in DEMI to eagle-api. Off until the organization cutover.')
param syncOutEagleOrganizationEnabled bool = false

@description('Also send projects written in DEMI to eagle-api. Off until the project cutover.')
param syncOutEagleProjectEnabled bool = false

@description('Also send updates written in DEMI to eagle-api. Off until the update cutover.')
param syncOutEagleUpdateEnabled bool = false

@description('Also send notifications written in DEMI to eagle-api. Off until the notification cutover.')
param syncOutEagleNotificationEnabled bool = false

@description('Also send comments written in DEMI to eagle-api. Off until the comment cutover.')
param syncOutEagleCommentEnabled bool = false

@description('eagle-api base the sync-out consumer writes to, e.g. https://eagle-test.apps.silver.devops.gov.bc.ca/api. Distinct from eagleApiBase, the public read path.')
param eagleProtectedApiBase string = ''

@description('Eagle milestone id sent on every comment period the consumer writes.')
param eagleEngageMilestone string = ''

@description('NCRONTAB schedule for the ENGAGE reconcile timer, e.g. `0 30 10 * * *`. Empty runs it never.')
param reconcileEngageSchedule string = ''

@description('ENGAGE public API base the reconcile scripts read. Empty skips their ENGAGE side.')
param engageApiBase string = ''

// Empty refuses every writer, so blanking it closes the ENGAGE ingest. Never share a principal with eagleMirrorPrincipals.
@description('Comma-separated registry row ids permitted on PUT /engage/*.')
param engagePrincipals string = 'apim:engage'

// Same rules as engagePrincipals. Never share a principal with that list or eagleMirrorPrincipals.
@description('Comma-separated registry row ids permitted on PUT and DELETE under /track/*.')
param trackPrincipals string = 'apim:track'

@description('Deploy the log alert that fires when the nightly Track teams sync still finds project drift. Off until Track pushes its writes, because until then the nightly is the only writer and fires every night.')
param deployTrackDriftAlert bool = false

@description('Deploy the log alert that fires when a bulk job fails.')
param deployBulkDownloadPoisonAlert bool = false

// At 0.3812 CAD per million RU, 3M RU/h is about 27 CAD a day. Test idles at a few hundred RU an
// hour; a runaway ingest loop ran 4-8M. Each .bicepparam sets its own.
@description('Request units in one hour above which the Cosmos spend alert fires.')
param cosmosRuPerHourAlert int = 3000000

@description('Most documents one authenticated bulk job may ask for.')
param bulkMaxDocuments int = 2500

@description('Same cap for anonymous callers.')
param bulkAnonMaxDocuments int = 100

@description('Bytes per zip part. A job larger than this splits into numbered parts.')
param bulkMaxBytes int = 2147483648

@description('Bytes across all parts of one job. Over it, the request is refused.')
param bulkMaxTotalBytes int = 21474836480

@description('Objects the worker opens ahead of the zip entry it is writing, so the next round trips overlap the current append.')
param bulkFetchAhead int = 3

@description('Objects the worker READS at once, buffering the ones ahead of the entry it is writing. 1 reads one at a time, which is the behaviour bulkFetchAhead alone gives. Above 1 it supersedes bulkFetchAhead.')
param bulkFetchConcurrency int = 1

@description('Bytes those concurrent reads may hold in total, split evenly between them.')
param bulkFetchBufferBytes int = 268435456

@description('Unfinished jobs one requester may hold.')
param bulkMaxPending int = 3

@description('Days a built zip stays downloadable.')
param bulkZipRetentionDays int = 7

@description('Days the job row lives. Longer than the zip retention, so the sweep still sees the row that owns an expired zip.')
param bulkJobTtlDays int = 30

@description('Jobs one requester may start in 24 hours.')
param bulkMaxPerDay int = 20

@description('Milliseconds a queued job may wait before the worker refuses it as too old to trust its access snapshot.')
param bulkMaxJobAgeMs int = 7200000

// The public URL, not the app's own host: a probe aimed at the app stays green when the edge in
// front of it breaks. Not composable, for the same reason as `frontendHostNames`.
@description('Absolute URL the availability web test GETs. Empty deploys no test.')
param availabilityUrl string = ''

// APIM Consumption in front of the Flex app: subscription keys and per-consumer rate limits. Off
// everywhere but test — a prod re-apply is a separate, deliberate deploy.
@description('Deploy the API Management gateway. Requires apiFlexSubnetId, since it fronts that app.')
param deployApim bool = false

// eagle-analytics shares this gateway to avoid a second Consumption fixed cost. Empty values below
// skip the analytics API, its products and the audit repoint.
@description('Absolute base URL of analytics-api-fc-<env>, read from the eagle-analytics deployment `apiHostName` output. NEVER composed: a Function App host name can carry a regional suffix. Empty deploys no analytics API.')
param analyticsBackendUrl string = ''

// APIM reads the header values from the vault as `analytics-shared-header` and
// `analytics-audit-header`; eagle-analytics reads them as APIM_SHARED_HEADER_VALUE and AUDIT_SHARED_HEADER_VALUE.

// Audit repoint: privileged actions go to EagleAudit_CL in eagle-analytics, usage stays on DEMI's
// DCR. DemiAudit_CL rows are not migrated; they age out and GET /admin/audit unions both.
@description('Logs Ingestion endpoint of analytics-dcr-<env>, from the eagle-analytics `eventsDcrEndpoint` output. Empty keeps audit rows on DEMI\'s own DCR.')
param analyticsDcrEndpoint string = ''

@description('Immutable ID of that DCR, from the eagle-analytics `eventsDcrImmutableId` output. Both this and the endpoint are required before anything is repointed.')
param analyticsDcrImmutableId string = ''

@description('Workspace GUID of analytics-logs-<env>, from the eagle-analytics `analyticsWorkspaceCustomerId` output. Empty keeps GET /admin/audit reading DemiAudit_CL alone.')
param analyticsWorkspaceCustomerId string = ''

// Derived from frontendHostNames so the AFD hosts are not listed twice; only the admin app queries.
// Never localhost in prod. Zero origins, not the environment name, disarms apim.bicep's bearer policies.
var analyticsAdminOrigins = concat(
  map(filter(frontendHostNames, host => startsWith(host, 'demi-admin')), host => 'https://${host}'),
  environmentName == 'prod' ? [] : [ 'http://localhost:4200' ]
)

// The dev-access VM. Off by default: it is a per-environment opt-in, and an environment without the
// subnet gets nothing rather than a half-built one.
@description('Deploy the dev-access VM that replaces the App Service SSH tunnel.')
param deployDevbox bool = false

@description('Non-delegated landing-zone subnet for the devbox NIC. Empty deploys no VM.')
param devboxSubnetId string = ''

// A public key, so no @secure(). Nothing SSHes in, but Compute refuses a Linux VM with no
// credential; the param file reads it from the environment.
@description('SSH public key for the devbox admin user.')
param devboxSshPublicKey string = ''

// Entra SSH login for the devbox, off by default; see modules/devbox.bicep
@description('Install the Entra ID SSH extension on the devbox and grant VM login.')
param devboxEnableEntraSsh bool = false

@description('Object id of the Entra user or group that gets Virtual Machine User Login on the devbox.')
param devboxEntraSshPrincipalId string = ''

// Re-PUTting the unchanging foundation is about 293 s of a 317 s deploy. False reads it by name;
// foundation edits need `scripts/deploy-infra.sh --foundation`, which sets DEPLOY_FOUNDATION.
@description('Deploy the foundation layer: identity, vault, Cosmos, observability, audit logs, Foundry, search, APIM, static site, document storage, document intake, budget.')
param deployFoundation bool = false

// Created out of band in the vault, shared by the gateway (named value) and the app (app setting).
var apimGatewaySecretName = 'apim-gateway-secret'

var defaultTags = {
  Project: 'DEMI'
  Application: 'eagle-demi'
  Environment: environmentName
  ManagedBy: 'Bicep'
  CostCenter: 'c4b0a8'
}

// Foundation lookups: name and apiVersion must match the owning module, or settings drift silently.
// ARM reads every unconditional `existing` whichever branch wins, so a partial one carries its use's `if`.

resource identityExisting 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: 'demi-identity-${environmentName}'
}

resource vaultExisting 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: 'demi-kv-${environmentName}'
}

resource cosmosExisting 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' existing = {
  name: 'demi-cosmos-${environmentName}'
}

resource logsWorkspaceExisting 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: 'demi-logs-${environmentName}'
}

resource auditWorkspaceExisting 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: 'demi-audit-${environmentName}'
}

resource appInsightsExisting 'Microsoft.Insights/components@2020-02-02' existing = {
  name: 'demi-insights-${environmentName}'
}

resource actionGroupExisting 'Microsoft.Insights/actionGroups@2023-01-01' existing = {
  name: 'demi-alerts-${environmentName}'
}

resource auditDcrExisting 'Microsoft.Insights/dataCollectionRules@2023-03-11' existing = {
  name: 'demi-audit-dcr-${environmentName}'
}

resource foundryExisting 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = if (deployFoundry && !deployFoundation) {
  name: 'demi-foundry-${environmentName}'
}

resource intakeIdentityExisting 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = if (deployDocumentIntake && !deployFoundation) {
  name: 'demi-intake-${environmentName}'
}

// One var per borrowed value. Everything below the foundation modules reads these and never a
// module output, so the value an application-only run writes is the value a full run writes.
var identityId = deployFoundation ? identity!.outputs.identityId : identityExisting.id
var identityPrincipalId = deployFoundation ? identity!.outputs.principalId : identityExisting.properties.principalId
var identityClientId = deployFoundation ? identity!.outputs.clientId : identityExisting.properties.clientId

var cosmosEndpoint = deployFoundation ? cosmos!.outputs.cosmosEndpoint : cosmosExisting.properties.documentEndpoint
var cosmosAccountId = deployFoundation ? cosmos!.outputs.cosmosAccountId : cosmosExisting.id

var vaultName = deployFoundation ? keyVault!.outputs.vaultName : vaultExisting.name
var vaultUri = deployFoundation ? keyVault!.outputs.vaultUri : vaultExisting.properties.vaultUri

// Must stay character-identical to key-vault.bicep's outputs: `appSettings` is a whole-collection
// PUT, so even a trailing-slash difference rewrites a live Key Vault reference.
var secretUriBase = '${vaultUri}secrets/'
var adminApiKeySecretUri = deployFoundation ? keyVault!.outputs.adminApiKeySecretUri : '${secretUriBase}admin-api-key'
var doclingApiKeySecretUri = deployFoundation ? keyVault!.outputs.doclingApiKeySecretUri : '${secretUriBase}docling-api-key'
var minioAccessKeySecretUri = deployFoundation ? keyVault!.outputs.minioAccessKeySecretUri : '${secretUriBase}minio-access-key'
var minioSecretKeySecretUri = deployFoundation ? keyVault!.outputs.minioSecretKeySecretUri : '${secretUriBase}minio-secret-key'
var trackClientSecretUri = deployFoundation ? keyVault!.outputs.trackClientSecretUri : '${secretUriBase}track-client-secret'
var roleSyncClientSecretUri = deployFoundation ? keyVault!.outputs.roleSyncClientSecretUri : '${secretUriBase}role-sync-client-secret'

// Optional secrets: same `contains` test as key-vault.bicep, so an application-only run cannot hand
// prod a live reference where a full run hands it ''.
var notifyApiKeySecretUri = deployFoundation
  ? keyVault!.outputs.notifyApiKeySecretUri
  : (contains(optionalSecretNames, 'notify-api-key') ? '${secretUriBase}notify-api-key' : '')
var edgeSecretUri = deployFoundation
  ? keyVault!.outputs.edgeSecretUri
  : (contains(optionalSecretNames, 'edge-secret') ? '${secretUriBase}edge-secret' : '')
var accessGateSecretUri = deployFoundation
  ? keyVault!.outputs.accessGateSecretUri
  : (contains(optionalSecretNames, 'access-gate-password') ? '${secretUriBase}access-gate-password' : '')
// Same test, one branch: key-vault.bicep has no output for it, and both branches compose from vaultUri anyway.
var syncOutEagleClientSecretUri = contains(optionalSecretNames, 'eagle-sync-out-client-secret')
  ? '${secretUriBase}eagle-sync-out-client-secret'
  : ''
var edgeBanPolicySecretUri = contains(optionalSecretNames, 'edge-ban-policy')
  ? '${secretUriBase}edge-ban-policy'
  : ''
// Plain URI, not a reference: the checker reads it and its -standby twin from the vault itself.
var apimGatewaySecretUri = deployApim ? '${secretUriBase}${apimGatewaySecretName}' : ''

var appInsightsConnectionString = deployFoundation ? observability!.outputs.connectionString : appInsightsExisting.properties.ConnectionString
var appInsightsId = deployFoundation ? observability!.outputs.appInsightsId : appInsightsExisting.id
var actionGroupId = deployFoundation ? observability!.outputs.actionGroupId : actionGroupExisting.id
var appLogsWorkspaceName = deployFoundation ? observability!.outputs.workspaceName : logsWorkspaceExisting.name
var appLogsWorkspaceId = deployFoundation ? observability!.outputs.workspaceId : logsWorkspaceExisting.id
var appLogsWorkspaceCustomerId = deployFoundation ? observability!.outputs.workspaceCustomerId : logsWorkspaceExisting.properties.customerId

var auditDcrEndpoint = deployFoundation ? auditLogs!.outputs.dcrEndpoint : auditDcrExisting.properties.endpoints.logsIngestion
var auditDcrImmutableId = deployFoundation ? auditLogs!.outputs.dcrImmutableId : auditDcrExisting.properties.immutableId
var auditWorkspaceId = deployFoundation ? auditLogs!.outputs.workspaceId : auditWorkspaceExisting.id
var auditWorkspaceName = deployFoundation ? auditLogs!.outputs.workspaceName : auditWorkspaceExisting.name
var auditWorkspaceCustomerId = deployFoundation ? auditLogs!.outputs.workspaceCustomerId : auditWorkspaceExisting.properties.customerId

var foundryEndpoint = deployFoundry
  ? (deployFoundation ? foundry!.outputs.foundryEndpoint : foundryExisting!.properties.endpoint)
  : ''

// Composed, not borrowed: each module builds the same name from environmentName. The model name is
// passed down to foundry.bicep so the app setting is right in a run with no Foundry account.
var foundryModelName = 'gpt-4.1-mini'
var foundryDeployment = deployFoundry ? foundryModelName : ''
var searchEndpoint = deploySearch ? 'https://demi-search-${environmentName}.search.windows.net' : existingSearchEndpoint
var budgetName = 'demi-budget-${environmentName}'
var intakeStorageAccountName = take('demiin${environmentName}${uniqueString(resourceGroup().id)}', 24)
var intakeIdentityId = !deployDocumentIntake ? '' : (deployFoundation ? documentIntake!.outputs.intakeIdentityId : intakeIdentityExisting!.id)
var intakeIdentityClientId = !deployDocumentIntake ? '' : (deployFoundation ? documentIntake!.outputs.intakeIdentityClientId : intakeIdentityExisting!.properties.clientId)

// 1. User-assigned identity, the principal for every data plane. It outlives the app, so a redeploy
// keeps its role assignments, and the app names it with AZURE_CLIENT_ID.
module identity './modules/identity.bicep' = if (deployFoundation) {
  name: 'deploy-identity'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
  }
}

// 1b. Key Vault. Waits on identity for the secrets-read principal and on observability for the
// expiry alert's action group.
module keyVault './modules/key-vault.bicep' = if (deployFoundation) {
  name: 'deploy-key-vault'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
    peSubnetId: privateEndpointSubnetId
    identityPrincipalId: identityPrincipalId
    optionalSecretNames: optionalSecretNames
    actionGroupId: actionGroupId
  }
}

// 2. Cosmos DB for NoSQL, the system of record: serverless, keyless, private endpoint only. The
// module also grants the identity SQL data access.
module cosmos './modules/cosmos-nosql.bicep' = if (deployFoundation) {
  name: 'deploy-cosmos-nosql'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
    peSubnetId: privateEndpointSubnetId
    apiPrincipalId: identityPrincipalId
    readerPrincipalId: readerPrincipalId
    deployEnrichment: deployEnrichment
    // Bicep orders on output references, not declaration, and auditLogs depends only on identity
    // and observability, so there is no cycle.
    auditWorkspaceId: auditWorkspaceId
  }
}

// 3. Azure AI Search — the Deep Search query layer. Basic tier, one replica, one partition.
module search './modules/ai-search.bicep' = if (deployFoundation && deploySearch) {
  name: 'deploy-ai-search'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
    identityId: identityId
    // Both, and they are different things: the indexer authenticates AS the identity (resource
    // ID), while the data-plane role assignment inside the module grants TO its principal.
    apiPrincipalId: identityPrincipalId
    cosmosAccountId: cosmosAccountId
    peSubnetId: privateEndpointSubnetId
  }
}

// 3b. Search service not ours: only the data-plane grant and the shared private link to our Cosmos,
// the indexer's one route in. Re-PUTting anything else would fight the service's owner.
module existingSearchRole './modules/search-existing.bicep' = if (deployFoundation && !deploySearch) {
  name: 'grant-existing-search'
  params: {
    searchName: empty(existingSearchEndpoint)
      ? 'demi-search-${environmentName}'
      : first(split(replace(existingSearchEndpoint, 'https://', ''), '.'))
    apiPrincipalId: identityPrincipalId
    environmentName: environmentName
    cosmosAccountId: cosmosAccountId
    indexerPrincipalId: existingSearchIndexerPrincipalId
  }
}

// 4. Phase 3b document storage — see `deployDocumentStorage`. Not deployed in dev.
module documentStorage './modules/document-storage.bicep' = if (deployFoundation && deployDocumentStorage) {
  name: 'deploy-document-storage'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
    peSubnetId: privateEndpointSubnetId
    apiPrincipalId: identityPrincipalId
    readerPrincipalId: readerPrincipalId
  }
}

// 4b. Document intake staging account, scanned by Defender for Storage on upload.
module documentIntake './modules/document-intake.bicep' = if (deployFoundation && deployDocumentIntake) {
  name: 'deploy-document-intake'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
    storageAccountName: intakeStorageAccountName
    apiPrincipalId: identityPrincipalId
    capGBPerMonth: intakeCapGBPerMonth
    allowedOrigins: frontendHostNames
    peSubnetId: privateEndpointSubnetId
    logsWorkspaceId: observability!.outputs.workspaceId
    actionGroupId: actionGroupId
  }
}

// 5. Azure Monitor — Log Analytics workspace plus workspace-based Application Insights. Deployed
// before the apps because they consume its connection string; nothing else depends on it.
module observability './modules/observability.bicep' = if (deployFoundation) {
  name: 'deploy-observability'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
    apiPrincipalId: identityPrincipalId
    // Same list the budget alerts use — one place to change who gets told.
    contactEmails: contactEmails
    deployReconcileDriftAlert: deployReconcileDriftAlert
    deployBulkDownloadPoisonAlert: deployBulkDownloadPoisonAlert
    deployTrackDriftAlert: deployTrackDriftAlert
    chunkRestampQueue: chunkRestampQueue
    syncOutQueue: syncOutQueue
    // Same values the API timers get, so a timer that never runs has no alert expecting it.
    syncProjectsSchedule: syncProjectsSchedule
    syncTeamsSchedule: syncTeamsSchedule
  }
}

// 5b. A second workspace on purpose: the app one stops collecting at its `dailyQuotaGb` cap, which
// a compliance record cannot do. See modules/audit-logs.bicep.
module auditLogs './modules/audit-logs.bicep' = if (deployFoundation) {
  name: 'deploy-audit-logs'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
    apiPrincipalId: identityPrincipalId
    // The audit writer reports its own failures to the APPLICATION logger, so the alert that
    // catches a dropped batch has to query that workspace rather than the audit one.
    appLogsWorkspaceId: observability!.outputs.workspaceId
    // One action group for both alerts, owned by observability because it deploys first.
    alertActionGroupId: actionGroupId
  }
}

// 5c. Cosmos RU alert. After cosmos and observability both, which is why it is not inside either —
// see the header of modules/cosmos-alerts.bicep.
module cosmosAlerts './modules/cosmos-alerts.bicep' = if (deployFoundation) {
  name: 'deploy-cosmos-alerts'
  params: {
    environmentName: environmentName
    tags: defaultTags
    cosmosAccountId: cosmosAccountId
    actionGroupId: actionGroupId
    ruPerHourThreshold: cosmosRuPerHourAlert
  }
}

// 6. Microsoft Foundry — the summariser behind `GET /api/search/summary`, and the only resource
// here that touches a model. Retrieval stays lexical BM25 in `demi-search-dev`.
module foundry './modules/foundry.bicep' = if (deployFoundation && deployFoundry) {
  name: 'deploy-foundry'
  params: {
    modelName: foundryModelName
    // No `location`: the module defaults to canadaeast, the only Canadian region with a Standard
    // deployment. The PE is a NIC in our subnet, so `peLocation` stays with everything else.
    environmentName: environmentName
    tags: defaultTags
    identityPrincipalId: identityPrincipalId
    // Empty skips the PE via the module's own gate — see deployFoundryPrivateEndpoint above.
    peSubnetId: deployFoundryPrivateEndpoint ? privateEndpointSubnetId : ''
    peLocation: location
  }
}

// 7. REST API — Functions on Flex Consumption, in its own delegated subnet. The only API app.
module apiFunctionFlex './modules/api-function-flex.bicep' = if (!empty(apiFlexSubnetId)) {
  name: 'deploy-api-function-flex'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
    minioHost: minioHost
    minioAccessKeySecretUri: minioAccessKeySecretUri
    minioSecretKeySecretUri: minioSecretKeySecretUri
    minioBucketName: minioBucketName
    minioKeyPrefix: minioKeyPrefix
    adminApiKeySecretUri: adminApiKeySecretUri
    doclingApiKeySecretUri: doclingApiKeySecretUri
    eagleApiBase: eagleApiBase
    reconcileSchedule: reconcileSchedule
    trackApiBase: trackApiBase
    trackClientId: trackClientId
    trackWorksSync: trackWorksSync
    worksWrite: worksWrite
    worksRead: worksRead
    worksReadSources: worksReadSources
    assessmentPass: assessmentPass
    trackClientSecretUri: trackClientSecretUri
    roleSyncClientId: roleSyncClientId
    roleSyncClientSecretUri: roleSyncClientSecretUri
    notifyApiBase: notifyApiBase
    notifyApiKeySecretUri: notifyApiKeySecretUri
    notifyUpdateReaderLinks: notifyUpdateReaderLinks
    updatesPublishDateFallback: updatesPublishDateFallback
    announceUpdatesSchedule: announceUpdatesSchedule
    syncTeamsSchedule: syncTeamsSchedule
    syncProjectsSchedule: syncProjectsSchedule
    bulkDownloadsQueue: bulkDownloadsQueue
    bulkCleanupSchedule: bulkCleanupSchedule
    chunkRestampQueue: chunkRestampQueue
    searchDefinitionsQueue: searchDefinitionsQueue
    syncOutQueue: syncOutQueue
    syncOutEagleEnabled: syncOutEagleEnabled
    syncOutEagleNativeEnabled: syncOutEagleNativeEnabled
    syncOutEagleDocumentEnabled: syncOutEagleDocumentEnabled
    syncOutEagleOrganizationEnabled: syncOutEagleOrganizationEnabled
    syncOutEagleProjectEnabled: syncOutEagleProjectEnabled
    syncOutEagleUpdateEnabled: syncOutEagleUpdateEnabled
    syncOutEagleNotificationEnabled: syncOutEagleNotificationEnabled
    syncOutEagleCommentEnabled: syncOutEagleCommentEnabled
    eagleProtectedApiBase: eagleProtectedApiBase
    syncOutEagleClientSecretUri: syncOutEagleClientSecretUri
    eagleEngageMilestone: eagleEngageMilestone
    reconcileEngageSchedule: reconcileEngageSchedule
    engageApiBase: engageApiBase
    engagePrincipals: engagePrincipals
    trackPrincipals: trackPrincipals
    // The identity the SEARCH service runs indexers as, which is only ours when we deployed the
    // service: prod's `demi-search-prod` runs as `eagle-search-identity-prod`.
    dataSourceIdentityId: deploySearch ? identityId : existingSearchIndexerIdentityId
    bulkMaxDocuments: bulkMaxDocuments
    bulkAnonMaxDocuments: bulkAnonMaxDocuments
    bulkMaxBytes: bulkMaxBytes
    bulkMaxTotalBytes: bulkMaxTotalBytes
    bulkFetchAhead: bulkFetchAhead
    bulkFetchConcurrency: bulkFetchConcurrency
    bulkFetchBufferBytes: bulkFetchBufferBytes
    bulkMaxPending: bulkMaxPending
    bulkZipRetentionDays: bulkZipRetentionDays
    bulkJobTtlDays: bulkJobTtlDays
    bulkMaxPerDay: bulkMaxPerDay
    bulkMaxJobAgeMs: bulkMaxJobAgeMs
    keycloakClientId: keycloakClientId
    allowedClients: allowedClients
    eagleMirrorPrincipals: eagleMirrorPrincipals
    pdfTitleWorkerPrincipals: pdfTitleWorkerPrincipals
    backupAccountName: backupAccountName
    backupContainerName: backupContainerName
    ssoAudience: ssoAudience
    trustedProxyIps: trustedProxyIps
    edgeSecretUri: edgeSecretUri
    edgeGate: edgeGate
    edgeBanMode: edgeBanMode
    edgeBanSchedule: edgeBanSchedule
    edgeBanPolicySecretUri: edgeBanPolicySecretUri
    edgeLogWorkspaceId: edgeLogWorkspaceId
    edgeBanRuleId: edgeBanRuleId
    accessGateSecretUri: accessGateSecretUri
    virtualNetworkSubnetId: apiFlexSubnetId
    identityId: identityId
    identityClientId: identityClientId
    identityPrincipalId: identityPrincipalId
    cosmosEndpoint: cosmosEndpoint
    searchEndpoint: searchEndpoint
    searchIndexActivities: searchIndexActivities
    searchIndexProjectNotifications: searchIndexProjectNotifications
    appInsightsConnectionString: appInsightsConnectionString
    enrichmentSources: enrichmentSources
    summaryEnabled: summaryEnabled
    foundryEndpoint: foundryEndpoint
    foundryDeployment: foundryDeployment
    auditDcrEndpoint: auditDcrEndpoint
    auditDcrImmutableId: auditDcrImmutableId
    auditWorkspaceId: auditWorkspaceId
    auditWorkspaceCustomerId: auditWorkspaceCustomerId
    analyticsDcrEndpoint: analyticsDcrEndpoint
    analyticsDcrImmutableId: analyticsDcrImmutableId
    analyticsWorkspaceCustomerId: analyticsWorkspaceCustomerId
    appLogsWorkspaceCustomerId: appLogsWorkspaceCustomerId
    budgetName: budgetName
    frontendHostNames: frontendHostNames
    linkBaseUrl: linkBaseUrl
    intakeStorageAccount: deployDocumentIntake ? intakeStorageAccountName : ''
    intakeIncomingContainer: deployDocumentIntake ? intakeContainers.incoming : ''
    intakeQuarantineContainer: deployDocumentIntake ? intakeContainers.quarantine : ''
    intakeIdentityId: intakeIdentityId
    intakeIdentityClientId: intakeIdentityClientId
    intakeCapGBPerMonth: intakeCapGBPerMonth
    // VaultName/SecretName: the secret is created out of band, so no module outputs its URI. Empty
    // until APIM is deployed, which turns off the app's gateway trust branch.
    apimGatewaySecretRef: deployApim ? '@Microsoft.KeyVault(VaultName=${vaultName};SecretName=${apimGatewaySecretName})' : ''
    apimGatewaySecretUri: apimGatewaySecretUri
  }
}

// 7d. OpenShift secret sync: its own Flex app on the API subnet, so a bad deploy of it cannot take
// the API down. Needs both deploySecretSync and syncNamespaces.
module secretSync './modules/secret-sync.bicep' = if (deploySecretSync && !empty(syncNamespaces) && !empty(apiFlexSubnetId)) {
  name: 'deploy-secret-sync'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
    virtualNetworkSubnetId: apiFlexSubnetId
    identityId: identityId
    identityClientId: identityClientId
    identityPrincipalId: identityPrincipalId
    keyVaultName: vaultName
    keyVaultUri: vaultUri
    syncNamespaces: syncNamespaces
    appInsightsConnectionString: appInsightsConnectionString
  }
}

// 7e. The PDF title worker. Calls the Flex host directly rather than through APIM, whose 30 s
// limit is shorter than a title write.
var pdfTitleWorkerApiKeySecretName = 'pdf-title-worker-api-key'
var deployPdfTitleWorkerApp = deployPdfTitleWorker && contains(optionalSecretNames, pdfTitleWorkerApiKeySecretName) && !empty(apiFlexSubnetId)

module pdfTitleWorker './modules/pdf-title-worker.bicep' = if (deployPdfTitleWorkerApp) {
  name: 'deploy-pdf-title-worker'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
    virtualNetworkSubnetId: apiFlexSubnetId
    keyVaultName: vaultName
    apiKeySecretName: pdfTitleWorkerApiKeySecretName
    demiApiUrl: 'https://${apiFunctionFlex!.outputs.apiFunctionAppHostName}/api'
    schedule: pdfTitleSchedule
    live: pdfTitleLive
    maxRows: pdfTitleMaxRows
    maxMinutes: pdfTitleMaxMinutes
    appInsightsConnectionString: appInsightsConnectionString
  }
}

// 7f. The Key Vault secret rotator. Its own Flex app and identity on the API's subnet, so it reaches
// the vault through the private endpoint; the only app with write on the vault.
module secretRotator './modules/secret-rotator.bicep' = if (!empty(apiFlexSubnetId)) {
  name: 'deploy-secret-rotator'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
    virtualNetworkSubnetId: apiFlexSubnetId
    keyVaultName: vaultName
    keyVaultUri: vaultUri
    rotationTargets: rotatorTargets
    renew: rotatorRenew
    edgeRuleIds: rotatorEdgeRuleIds
    probeDemiUrl: rotatorProbeDemiUrl
    probeAnalyticsUrl: rotatorProbeAnalyticsUrl
    issuerExpiry: rotatorIssuerExpiry
    logsWorkspaceId: appLogsWorkspaceId
    actionGroupId: actionGroupId
    appInsightsConnectionString: appInsightsConnectionString
  }
}

// 7c. The gateway. After the Flex app because it fronts it, and skipped whenever that app is.
module apim './modules/apim.bicep' = if (deployFoundation && deployApim && !empty(apiFlexSubnetId)) {
  name: 'deploy-apim'
  params: {
    location: location
    tags: defaultTags
    apimName: 'demi-apim-${environmentName}'
    // Same list the cost and audit alerts notify; APIM takes one address, not an array.
    publisherEmail: contactEmails[0]
    apiHostName: apiFunctionFlex!.outputs.apiFunctionAppHostName
    keyVaultName: vaultName
    gatewaySecretName: apimGatewaySecretName
    // Another repository's estate: the module's own !empty() gate skips the analytics API when
    // eagle-analytics has not been deployed here.
    analyticsBackendUrl: analyticsBackendUrl
    // Gateway and vault are both foundation, so these two read the module directly rather than
    // through a lookup var — there is no run that deploys one without the other.
    analyticsSharedHeaderSecretUri: keyVault!.outputs.analyticsSharedHeaderSecretUri
    analyticsAuditHeaderSecretUri: keyVault!.outputs.analyticsAuditHeaderSecretUri
    analyticsBrowserOrigins: analyticsAdminOrigins
  }
}

// 7b. Synthetic availability probe. Separate from observability.bicep because that module is
// unconditional and this one is a per-environment opt-in.
module availability './modules/availability.bicep' = if (!empty(availabilityUrl)) {
  name: 'deploy-availability'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
    targetUrl: availabilityUrl
    appInsightsId: appInsightsId
    actionGroupId: actionGroupId
  }
}

// 7d. Dev-access VM. Same identity as the API, so a script run here has the app's data-plane access
// and no more. Deallocated between sessions; see README "Running anything against the database".
module devbox './modules/devbox.bicep' = if (deployDevbox && !empty(devboxSubnetId)) {
  name: 'deploy-devbox'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
    subnetId: devboxSubnetId
    sshPublicKey: devboxSshPublicKey
    enableEntraSsh: devboxEnableEntraSsh
    entraSshPrincipalId: devboxEntraSshPrincipalId
    identityId: identityId
    identityClientId: identityClientId
    // The same expressions the API app gets, so demi-run cannot drift from the running app.
    cosmosEndpoint: cosmosEndpoint
    searchEndpoint: searchEndpoint
    eagleApiBase: eagleApiBase
  }
}

// 8. Frontend origin, a Storage static website. Front Door supplies TLS, host, headers and routing;
// see modules/static-site.bicep for the one data-plane step ARM cannot express.
module staticSite './modules/static-site.bicep' = if (deployFoundation && deployStaticSite) {
  name: 'deploy-static-site'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
    uploaderPrincipalId: frontendUploaderPrincipalId
  }
}

// 9. Cost budget alerts. AI Search Basic is a fixed monthly charge whether queried or idle.
module costBudget './modules/cost-budget.bicep' = if (deployFoundation) {
  name: 'deploy-cost-budget'
  params: {
    environmentName: environmentName
    budgetAmount: budgetAmount
    contactEmails: contactEmails
    startDate: budgetStartDate
  }
}

// Cost Management Reader at this group, the scope GET /admin/cost queries. The name uses the
// identity's name, not its principal id: a resource name cannot hold a runtime value.
var costManagementReaderRoleId = '72fafb9e-0641-4937-9268-a91bfd8191a3'

resource costReaderAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, 'demi-identity-${environmentName}', costManagementReaderRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', costManagementReaderRoleId)
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Outputs
// Empty when no Flex subnet is supplied, which is the only way to deploy no API app.
output apiFlexHostName string = !empty(apiFlexSubnetId) ? apiFunctionFlex!.outputs.apiFunctionAppHostName : ''
// The three below are empty in an application-only run: each is an ARM-assigned value read only
// right after a foundation deploy. This host is the Front Door origin, stable for the account's life.
output frontendStaticSiteHostName string = (deployFoundation && deployStaticSite) ? staticSite!.outputs.staticSiteHostName : ''
// The publish target for `scripts/deploy-azure.sh frontend` — carries a uniqueString suffix, so it
// goes into the repository variable AZURE_FRONTEND_STORAGE_ACCOUNT rather than a literal in CI.
output frontendStorageAccountName string = (deployFoundation && deployStaticSite) ? staticSite!.outputs.storageAccountName : ''
// The gateway machine and browser traffic is moved onto. Empty until deployApim is set.
output apimGatewayUrl string = (deployFoundation && deployApim && !empty(apiFlexSubnetId)) ? apim!.outputs.gatewayUrl : ''

// Empty where the environment deploys no sync app. The deploy workflow publishes the package to
// this name, so it is read rather than rebuilt from environmentName.
output secretSyncAppName string = (deploySecretSync && !empty(syncNamespaces) && !empty(apiFlexSubnetId)) ? secretSync!.outputs.secretSyncAppName : ''
// Empty where the worker is not deployed; the worker's deploy workflow publishes to this name.
output pdfTitleWorkerAppName string = deployPdfTitleWorkerApp ? pdfTitleWorker!.outputs.pdfTitleWorkerAppName : ''
// eagle-edge grants this principal write on its stampedgesecret rule sets.
output secretRotatorPrincipalId string = !empty(apiFlexSubnetId) ? secretRotator!.outputs.principalId : ''
// The VM every `az vm run-command invoke` addresses. Empty when the devbox is not deployed.
output devboxName string = (deployDevbox && !empty(devboxSubnetId)) ? devbox!.outputs.devboxName : ''
output searchEndpoint string = searchEndpoint
output cosmosEndpoint string = cosmosEndpoint
output identityClientId string = identityClientId
output logAnalyticsWorkspaceName string = appLogsWorkspaceName
output auditWorkspaceName string = auditWorkspaceName
// The query API addresses a workspace by this GUID, not by name or resource ID.
output auditWorkspaceCustomerId string = auditWorkspaceCustomerId
