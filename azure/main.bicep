// Root Bicep orchestrator for the DEMI Azure environment.
//
// WHAT THIS FILE IS. A description of what is actually deployed in `c4b0a8-dev-rg`, verified
// against the live resource group on 2026-08-04. It is not deployable today and is not deployed by
// CI: `azure-deploy-dev.yaml`'s infra job was reduced to `az bicep build` on 2026-08-04, and there
// is no federated credential for it to use in any case. Its job is to make the environment
// REBUILDABLE and to make drift visible, which the previous version could not do — it deployed a
// VNet, a Key Vault and a Static Web App, none of which exist here, and instantiated none of the
// five modules that describe what does.
//
// THE NETWORK IS NOT OURS. There is no VNet in this resource group and there must not be. The
// landing zone provides one in `c4b0a8-dev-networking` (`c4b0a8-dev-vwan-spoke`), and both the
// private endpoints and the app's VNet integration point into its subnets. So subnet IDs are
// PARAMETERS here.
//
// WHAT IS DELIBERATELY ABSENT.
//   - Static Web App. The frontend is a Storage static website (module 8) fronted by the Front
//     Door profile that lives in eagle-search.
//   - Cosmos DB for MongoDB. Cut loose at Phase 8; nothing speaks Mongo.
//   - Document storage. Phase 3b, written but never deployed — see `deployDocumentStorage`.
//
// NOT DESCRIBED HERE, because Azure creates them rather than us: the Log Analytics workspace
// (`workspace-c4b0a8devrgYb8e`, Defender/diagnostics) and the Event Grid system topic on the API
// storage account. Both exist in the group; neither is ours to declare.

targetScope = 'resourceGroup'

@description('Target Azure region')
param location string = 'canadacentral'

@description('Environment name (e.g. dev, test, prod)')
param environmentName string = 'dev'

@description('OpenShift MinIO Endpoint URL')
param minioHost string = 'minio-6cdc9e-dev.apps.silver.devops.gov.bc.ca'

@description('OpenShift MinIO Access Key')
@secure()
param minioAccessKey string

@description('OpenShift MinIO Secret Key')
@secure()
param minioSecretKey string

// `adminApiKey` is written to the Key Vault secret the app then reads by reference; `doclingApiKey`
// reaches an app setting directly. Both must be passed: a module default of '' would write
// ADMIN_API_KEY='' and DOCLING_API_KEY='' over the live values, destroying the break-glass
// credential and the extraction host's key. `what-if` cannot surface that, because @secure() values
// are masked in its output.
//
// The live app settings are the source of truth; the deploy round-trips them in. Empty is still
// permitted so a fresh environment can be stood up before the credentials exist.
// No `= ''` default on either: an unset value must fail the build, not deploy an empty string over
// a live credential. The param files source them from the environment with no fallback, so a
// forgotten export stops the deploy instead of silently destroying the app.
@description('Break-glass admin credential. Round-tripped from the live app settings at deploy time.')
@secure()
param adminApiKey string

@description('Extraction host credential. Same handling as adminApiKey.')
@secure()
param doclingApiKey string

@description('Upstream eagle-api the seed loader reads. Environment-specific — the code default is the DEV instance, so this must be set per environment or staging silently reads dev data.')
param eagleApiBase string

@description('Public origin short links redirect from, e.g. https://projects.eao.gov.bc.ca. Per environment: test must not hand back the prod host.')
param linkBaseUrl string = ''

// Bucket and prefix were previously set out of band, so every template deploy silently reset them
// to the module defaults ('eagle-demi', ''). Exposed here so the template describes reality.
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

// Subnets in the landing zone's VNet, which lives in another resource group and is not managed
// here. Empty values skip the private endpoints and VNet integration, which is only ever right for
// a scratch deployment — in this landing zone public network access is denied by policy, so an
// account without its private endpoint is unreachable rather than merely public.
@description('Existing landing-zone subnet for inbound private endpoints (c4b0a8-dev-networking).')
param privateEndpointSubnetId string = ''

@description('Object ID of a human principal granted read access to data planes. Empty grants none.')
param readerPrincipalId string = ''

// AN AFD ENDPOINT HOSTNAME IS NOT PREDICTABLE. It is `<name>-<hash>.<zone>.azurefd.net`, and Azure
// assigns both the hash and the zone code — so this cannot be derived, only observed. Fill it in
// from the eagle-search Front Door deployment's output, then redeploy this template.
//
// AN ARRAY, because during a cutover there are two. Publishing the new frontend while this named
// only the old one left every API call from the new origin CORS-blocked — the app loaded, then
// failed on /api/config and every /api/search. List both until the old one is decommissioned.
//
// Empty is the pre-Front-Door state and fails CLOSED rather than open: `CORS_ORIGIN` is then unset
// on the API, and src/app.js falls back to an allowlist holding only http://localhost:4200.
@description('Frontend hostnames (no scheme) allowed as browser origins against the API. Filled in after the AFD deployment in eagle-search — the hostname carries a deploy-time hash and cannot be guessed.')
param frontendHostNames array = []

@description('Principal id of the CI identity (demi-cicd-<env>) that publishes the frontend bundle into $web. Empty skips the role assignment, and the publish step then gets a 403.')
param frontendUploaderPrincipalId string = ''

// The `$web` origin for DEMI's own Angular frontend. Prod does not have one — eagle-public is the
// consumer there — so a prod deploy would otherwise create a storage account nothing ever publishes to.
@description('Deploy the frontend static-site storage account.')
param deployStaticSite bool = true

@description('Keycloak client whose tokens the API accepts.')
param keycloakClientId string = 'eagle-admin-console'

// No default, same rule as adminApiKey above: an unset value must fail the build. An empty string
// deployed to test or prod is an allowlist that admits every client in the realm.
@description('Comma-separated Keycloak client ids (token azp) permitted to call this API.')
param allowedClients string

// Empty, not 'account': the audience Keycloak actually mints is unmeasured, and a wrong value
// rejects every token. Empty means the check is not enforced.
@description('Expected JWT aud claim. Empty disables audience verification.')
param ssoAudience string = ''

// Empty until the rproxy egress address is measured per environment (one request through test,
// then App Insights `callerIp`). Until then every eagle-public visitor shares one quota key.
@description('Comma-separated egress IPs of proxies we run. An APIM-asserted address on this list makes the browser hop of X-Forwarded-For the caller.')
param trustedProxyIps string = ''

// Flex needs its own subnet, delegated to `Microsoft.App/environments`. Empty deploys no API app
// at all, so an environment that wants one must supply it.
@description('Delegated subnet for the Flex Consumption API app. Empty deploys no API.')
param apiFlexSubnetId string = ''

// Phase 3b. The module is written and the argument for it is per-environment isolation rather than
// cost, but nothing is deployed and nothing is copied — and turning it on needs `Storage Blob
// Delegator` on the identity or every download link fails to sign, which is NOT implied by
// `Storage Blob Data Contributor`. Off, so that this file keeps describing what exists.
@description('Deploy the Phase 3b document storage account. Off: dev still reads MinIO.')
param deployDocumentStorage bool = false

@description('Comma-separated `sources` keys a project may publish over HTTP. Empty publishes none.')
param enrichmentSources string = ''

// Containers, not app behaviour: `enrichmentSources` above decides what the API publishes, this
// decides whether the container behind it is declared at all. Prod publishes none.
// `boundaries` is reference data and is declared everywhere — see cosmos-nosql.bicep.
@description('Declare the Cosmos wildfires container.')
param deployEnrichment bool = true

// Prod's AI Search service was stood up ahead of the rest of the estate, from
// azure/ai-search.prod.bicepparam, and it also serves eagle-search-api-prod. Re-PUTting it from
// here would re-assert `semanticSearch` and the identity list against a live service this template
// is not the owner of. False points the API at the existing endpoint instead and grants only the
// one role the API needs on it.
@description('Deploy the AI Search service. False consumes `existingSearchEndpoint` and grants Search Index Data Contributor on the service already standing.')
param deploySearch bool = true

@description('Endpoint of an already-deployed search service, used when `deploySearch` is false.')
param existingSearchEndpoint string = ''

// An already-standing service runs its indexers as its own identity, not ours, so the Cosmos grant
// the ai-search path gets for free (same UAMI as the API) has to be made explicitly here.
@description('Principal of the identity the existing search service runs its indexers as. Used only when `deploySearch` is false; grants it Cosmos Data Reader.')
param existingSearchIndexerPrincipalId string = ''

// Unlike `summaryEnabled`, which is the app-side switch, this decides whether the Foundry ACCOUNT
// is created. Prod runs no summariser, so it should have no model resource to attribute or secure.
@description('Deploy the Foundry account and model deployment. False leaves FOUNDRY_ENDPOINT empty, which is the same state summaryEnabled=false already produces.')
param deployFoundry bool = true

// The kill switch for the summariser, and the only one that costs nothing to leave on. The Foundry
// account below bills PER TOKEN rather than per hour, so an idle deployment is free; what scales
// with use is queries, and `GET /api/search/summary` is privileged-only for exactly that reason.
// False leaves the account standing and makes the endpoint answer `{summary: null, reason:
// 'disabled'}` — retrieval is untouched either way.
@description('Turn the AI summariser on. The Foundry account is deployed regardless; this is the app-side switch.')
param summaryEnabled bool = true

// The Foundry private endpoint races its own account on every deploy. ARM PUTs the account, the
// Cognitive Services RP leaves it in state `Accepted` while it reconciles, and the PE — which
// depends on the account id — is then rejected with AccountProvisioningStateInvalid. It is
// deterministic, not flaky: three consecutive runs failed identically on 2026-08-13.
//
// A Failed foundry module means `foundry.outputs.foundryEndpoint` never resolves, so
// `deploy-api-function-flex` never runs at all — the failure is not safe to read past.
//
// So: false once the PE exists and is Approved, which reuses the module's existing
// `if (!empty(peSubnetId))` gate to skip re-PUTting a resource that is already correct. Leave it
// true for a fresh environment, where the PE has to be created and one failed run is the price.
@description('Create the Foundry private endpoint. Set false when it already exists — re-PUTting it races the account PUT and fails the whole deployment.')
param deployFoundryPrivateEndpoint bool = true

// The nightly Eagle drift report, a Functions timer trigger in the API app (api/index.js). Two
// halves of one feature and both default off: the schedule is what makes the job run, the bool is
// what makes the alert exist. Set both together — an alert with no run is silent, a run with no
// alert is a log line nobody reads.
@description('NCRONTAB schedule for the Eagle reconcile timer, e.g. `0 0 9 * * *`. Empty runs it never.')
param reconcileSchedule string = ''

@description('Deploy the log alert that fires when that run reports drift.')
param deployReconcileDriftAlert bool = false

// The nightly Track team sync, a second Functions timer (api/index.js) that mints `project:<id>`
// realm roles from Track's team-members endpoint. Four settings and a schedule, and the schedule
// is the switch: empty registers no timer, which is where every environment starts.
@description('Base URL of the Track API the team sync reads, e.g. https://epictrack-api-c72cba-test.apps.gold.devops.gov.bc.ca. Empty runs no sync.')
param trackApiBase string = ''

@description('Keycloak client id of the Track service account (client credentials).')
param trackClientId string = ''

// No default, same rule as adminApiKey: an unset value must fail the build rather than write an
// empty secret over a live one.
@description('Client secret for trackClientId. Written to the Key Vault secret the app reads by reference.')
@secure()
param trackClientSecret string

@description('Keycloak client id of the realm-management service account the sync grants roles with.')
param roleSyncClientId string = ''

@description('Client secret for roleSyncClientId. Same handling as trackClientSecret.')
@secure()
param roleSyncClientSecret string

@description('NCRONTAB schedule for the Track team sync timer, e.g. `0 0 10 * * *`. Empty runs it never.')
param syncTeamsSchedule string = ''

// Bulk document download. Three switches and a set of caps; the switches default off, so an
// environment gets the queue and the container without the feature running. The caps are the same
// everywhere until measurement says otherwise — a .bicepparam sets one only to override it.
@description('Storage queue the bulk-download worker triggers on, e.g. `bulk-downloads`. Empty runs no worker.')
param bulkDownloadsQueue string = ''

@description('NCRONTAB schedule for the zip cleanup timer, e.g. `0 30 3 * * *`. Empty runs it never.')
param bulkCleanupSchedule string = ''

@description('Deploy the log alert that fires when a bulk job fails.')
param deployBulkDownloadPoisonAlert bool = false

@description('Most documents one authenticated bulk job may ask for.')
param bulkMaxDocuments int = 2500

@description('Same cap for anonymous callers.')
param bulkAnonMaxDocuments int = 100

@description('Bytes per zip part. A job larger than this splits into numbered parts.')
param bulkMaxBytes int = 2147483648

@description('Bytes across all parts of one job. Over it, the request is refused.')
param bulkMaxTotalBytes int = 21474836480

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

// THE PUBLIC URL, not this API's own hostname. rproxy resolves the Front Door address once at
// config load, so a probe aimed straight at the app stays green through a moved edge — the failure
// this exists to catch. Not composable here for the same reason `frontendHostNames` is not.
@description('Absolute URL the availability web test GETs. Empty deploys no test.')
param availabilityUrl string = ''

// APIM Consumption in front of the Flex app: subscription keys and per-consumer rate limits. Off
// everywhere but test — a prod re-apply is a separate, deliberate deploy.
@description('Deploy the API Management gateway. Requires apiFlexSubnetId, since it fronts that app.')
param deployApim bool = false

// The dev-access VM. Off by default: it is a per-environment opt-in, and an environment without the
// subnet gets nothing rather than a half-built one.
@description('Deploy the dev-access VM that replaces the App Service SSH tunnel.')
param deployDevbox bool = false

@description('Non-delegated landing-zone subnet for the devbox NIC. Empty deploys no VM.')
param devboxSubnetId string = ''

// A PUBLIC key, so no @secure(): masking it would only hide it from what-if. Nothing SSHes in, but
// the Compute API refuses a Linux VM with no credential at all — the param file reads it from the
// environment rather than committing one.
@description('SSH public key for the devbox admin user.')
param devboxSshPublicKey string = ''

// Mandatory Cost Management Tags applied across ALL resources
// Created out of band in the vault, shared by the gateway (named value) and the app (app setting).
var apimGatewaySecretName = 'apim-gateway-secret'

var defaultTags = {
  Project: 'DEMI'
  Application: 'eagle-demi'
  Environment: environmentName
  ManagedBy: 'Bicep'
  CostCenter: 'c4b0a8'
}

// 1. User-assigned managed identity — the principal for EVERY data plane.
//
// User-assigned rather than system-assigned, and the distinction is load-bearing: the identity
// outlives the app, so a redeploy does not invalidate the role assignments below, and the app can
// name it with AZURE_CLIENT_ID. `demi-identity-dev`, principal c2de07f1-…, is the identity the
// live API actually runs as.
module identity './modules/identity.bicep' = {
  name: 'deploy-identity'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
  }
}

// 1b. Key Vault — holds ADMIN_API_KEY, which the API reads by reference rather than as a stored
// setting. Declared after identity because the secrets-read grant needs its principal.
module keyVault './modules/key-vault.bicep' = {
  name: 'deploy-key-vault'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
    peSubnetId: privateEndpointSubnetId
    identityPrincipalId: identity.outputs.principalId
    adminApiKey: adminApiKey
    trackClientSecret: trackClientSecret
    roleSyncClientSecret: roleSyncClientSecret
  }
}

// 2. Cosmos DB for NoSQL — the system of record. Serverless, keyless (`disableLocalAuth`), reached
// only through a private endpoint. The module also carries the SQL role assignment that lets the
// identity read and write it.
module cosmos './modules/cosmos-nosql.bicep' = {
  name: 'deploy-cosmos-nosql'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
    peSubnetId: privateEndpointSubnetId
    apiPrincipalId: identity.outputs.principalId
    readerPrincipalId: readerPrincipalId
    deployEnrichment: deployEnrichment
    // Control-plane auditing. This reverses the usual reading order — cosmos is module 2 and
    // auditLogs is module 6 — but Bicep orders on output references, not declaration, and
    // auditLogs depends only on identity and observability, so there is no cycle.
    auditWorkspaceId: auditLogs.outputs.workspaceId
  }
}

// 3. Azure AI Search — the Deep Search query layer. Basic tier, one replica, one partition.
module search './modules/ai-search.bicep' = if (deploySearch) {
  name: 'deploy-ai-search'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
    identityId: identity.outputs.identityId
    // Both, and they are different things: the indexer authenticates AS the identity (resource
    // ID), while the data-plane role assignment inside the module grants TO its principal.
    apiPrincipalId: identity.outputs.principalId
    cosmosAccountId: cosmos.outputs.cosmosAccountId
    peSubnetId: privateEndpointSubnetId
  }
}

// 3b. What the API needs when the search service is not ours to deploy: the data-plane grant, and
// the shared private link to OUR Cosmos account — the indexer has no other route to it, since the
// account is publicNetworkAccess: Disabled. Nothing else about the service is touched: no identity,
// no `semanticSearch`, no private endpoint — a re-PUT of any of those would fight whoever owns it.
module existingSearchRole './modules/search-existing.bicep' = if (!deploySearch) {
  name: 'grant-existing-search'
  params: {
    searchName: empty(existingSearchEndpoint)
      ? 'demi-search-${environmentName}'
      : first(split(replace(existingSearchEndpoint, 'https://', ''), '.'))
    apiPrincipalId: identity.outputs.principalId
    environmentName: environmentName
    cosmosAccountId: cosmos.outputs.cosmosAccountId
    indexerPrincipalId: existingSearchIndexerPrincipalId
  }
}

// 4. Phase 3b document storage — see `deployDocumentStorage`. Not deployed in dev.
module documentStorage './modules/document-storage.bicep' = if (deployDocumentStorage) {
  name: 'deploy-document-storage'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
    peSubnetId: privateEndpointSubnetId
    apiPrincipalId: identity.outputs.principalId
    readerPrincipalId: readerPrincipalId
  }
}

// 5. Azure Monitor — Log Analytics workspace plus workspace-based Application Insights. Deployed
// before the apps because they consume its connection string; nothing else depends on it.
module observability './modules/observability.bicep' = {
  name: 'deploy-observability'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
    apiPrincipalId: identity.outputs.principalId
    // Same list the budget alerts use — one place to change who gets told.
    contactEmails: contactEmails
    deployReconcileDriftAlert: deployReconcileDriftAlert
    deployBulkDownloadPoisonAlert: deployBulkDownloadPoisonAlert
  }
}

// 5b. Audit and usage-analytics store. A SECOND Log Analytics workspace, deliberately: the one
// above is capped with `dailyQuotaGb` and stops collecting once the cap is hit, which is correct
// for application logs and unacceptable for a compliance record. See modules/audit-logs.bicep.
module auditLogs './modules/audit-logs.bicep' = {
  name: 'deploy-audit-logs'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
    apiPrincipalId: identity.outputs.principalId
    // The audit writer reports its own failures to the APPLICATION logger, so the alert that
    // catches a dropped batch has to query that workspace rather than the audit one.
    appLogsWorkspaceId: observability.outputs.workspaceId
    // One action group for both alerts, owned by observability because it deploys first.
    alertActionGroupId: observability.outputs.actionGroupId
  }
}

// 6. Microsoft Foundry — the summariser behind `GET /api/search/summary`, and the only resource
// here that touches a model. Retrieval stays lexical BM25 in `demi-search-dev`.
module foundry './modules/foundry.bicep' = if (deployFoundry) {
  name: 'deploy-foundry'
  params: {
    // `location` is deliberately NOT passed: the module defaults to canadaeast, the only Canadian
    // region offering a Standard (in-country) deployment. `peLocation` is where the private endpoint
    // goes, and a PE is a NIC in its subnet — so it stays canadacentral with everything else.
    environmentName: environmentName
    tags: defaultTags
    identityPrincipalId: identity.outputs.principalId
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
    minioAccessKey: minioAccessKey
    minioSecretKey: minioSecretKey
    minioBucketName: minioBucketName
    minioKeyPrefix: minioKeyPrefix
    adminApiKeySecretUri: keyVault.outputs.adminApiKeySecretUri
    doclingApiKey: doclingApiKey
    eagleApiBase: eagleApiBase
    reconcileSchedule: reconcileSchedule
    trackApiBase: trackApiBase
    trackClientId: trackClientId
    trackClientSecretUri: keyVault.outputs.trackClientSecretUri
    roleSyncClientId: roleSyncClientId
    roleSyncClientSecretUri: keyVault.outputs.roleSyncClientSecretUri
    syncTeamsSchedule: syncTeamsSchedule
    bulkDownloadsQueue: bulkDownloadsQueue
    bulkCleanupSchedule: bulkCleanupSchedule
    bulkMaxDocuments: bulkMaxDocuments
    bulkAnonMaxDocuments: bulkAnonMaxDocuments
    bulkMaxBytes: bulkMaxBytes
    bulkMaxTotalBytes: bulkMaxTotalBytes
    bulkMaxPending: bulkMaxPending
    bulkZipRetentionDays: bulkZipRetentionDays
    bulkJobTtlDays: bulkJobTtlDays
    bulkMaxPerDay: bulkMaxPerDay
    bulkMaxJobAgeMs: bulkMaxJobAgeMs
    keycloakClientId: keycloakClientId
    allowedClients: allowedClients
    ssoAudience: ssoAudience
    trustedProxyIps: trustedProxyIps
    virtualNetworkSubnetId: apiFlexSubnetId
    identityId: identity.outputs.identityId
    identityClientId: identity.outputs.clientId
    identityPrincipalId: identity.outputs.principalId
    cosmosEndpoint: cosmos.outputs.cosmosEndpoint
    searchEndpoint: deploySearch ? search!.outputs.searchEndpoint : existingSearchEndpoint
    appInsightsConnectionString: observability.outputs.connectionString
    enrichmentSources: enrichmentSources
    summaryEnabled: summaryEnabled
    foundryEndpoint: deployFoundry ? foundry!.outputs.foundryEndpoint : ''
    foundryDeployment: deployFoundry ? foundry!.outputs.deploymentName : ''
    auditDcrEndpoint: auditLogs.outputs.dcrEndpoint
    auditDcrImmutableId: auditLogs.outputs.dcrImmutableId
    auditWorkspaceId: auditLogs.outputs.workspaceId
    auditWorkspaceCustomerId: auditLogs.outputs.workspaceCustomerId
    appLogsWorkspaceCustomerId: observability.outputs.workspaceCustomerId
    // From the budget module rather than rebuilt from environmentName: one place owns the name.
    budgetName: costBudget.outputs.budgetName
    frontendHostNames: frontendHostNames
    linkBaseUrl: linkBaseUrl
    // VaultName/SecretName rather than SecretUri: the secret is created out of band, so no module
    // outputs its versioned identifier. Empty until APIM is deployed, which disables the app's
    // gateway trust branch entirely.
    apimGatewaySecretRef: deployApim ? '@Microsoft.KeyVault(VaultName=${keyVault.outputs.vaultName};SecretName=${apimGatewaySecretName})' : ''
  }
}

// 7c. The gateway. After the Flex app because it fronts it, and skipped whenever that app is.
module apim './modules/apim.bicep' = if (deployApim && !empty(apiFlexSubnetId)) {
  name: 'deploy-apim'
  params: {
    location: location
    tags: defaultTags
    apimName: 'demi-apim-${environmentName}'
    // Same list the cost and audit alerts notify; APIM takes one address, not an array.
    publisherEmail: contactEmails[0]
    apiHostName: apiFunctionFlex!.outputs.apiFunctionAppHostName
    keyVaultName: keyVault.outputs.vaultName
    gatewaySecretName: apimGatewaySecretName
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
    appInsightsId: observability.outputs.appInsightsId
    actionGroupId: observability.outputs.actionGroupId
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
    identityId: identity.outputs.identityId
    identityClientId: identity.outputs.clientId
    // The same expressions the API app gets, so demi-run cannot drift from the running app.
    cosmosEndpoint: cosmos.outputs.cosmosEndpoint
    searchEndpoint: deploySearch ? search!.outputs.searchEndpoint : existingSearchEndpoint
    eagleApiBase: eagleApiBase
  }
}

// 8. Angular frontend — a Storage static website, no App Service and no plan. TLS, the hostname,
// the security headers and the routing rules are supplied by the Front Door profile in
// eagle-search; this template owns only the origin. See modules/static-site.bicep for the one
// data-plane command ARM cannot express.
module staticSite './modules/static-site.bicep' = if (deployStaticSite) {
  name: 'deploy-static-site'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
    uploaderPrincipalId: frontendUploaderPrincipalId
  }
}

// 9. Cost budget alerts. AI Search Basic is a fixed monthly charge whether queried or idle, which
// is what moved the ceiling to 100.
module costBudget './modules/cost-budget.bicep' = {
  name: 'deploy-cost-budget'
  params: {
    environmentName: environmentName
    budgetAmount: budgetAmount
    contactEmails: contactEmails
    startDate: budgetStartDate
  }
}

// Cost Management Reader for the API identity, at this resource group — the scope GET /admin/cost
// queries and the scope the budget above is defined on. Read-only, and it sees this group only.
//
// The name is built from the identity's NAME, not its principal id: a resource name cannot contain
// a runtime value, and `identity.outputs.principalId` is one. The properties may, and do.
var costManagementReaderRoleId = '72fafb9e-0641-4937-9268-a91bfd8191a3'

resource costReaderAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, 'demi-identity-${environmentName}', costManagementReaderRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', costManagementReaderRoleId)
    principalId: identity.outputs.principalId
    principalType: 'ServicePrincipal'
  }
}

// Outputs
// Empty when no Flex subnet is supplied, which is the only way to deploy no API app.
output apiFlexHostName string = !empty(apiFlexSubnetId) ? apiFunctionFlex!.outputs.apiFunctionAppHostName : ''
// COPY THIS INTO eagle-search's Front Door parameters. The profile owns the DEMI route but not the
// origin, so it needs this hostname to add one; it is stable for the life of the storage account.
output frontendStaticSiteHostName string = deployStaticSite ? staticSite!.outputs.staticSiteHostName : ''
// The publish target for `scripts/deploy-azure.sh frontend` — carries a uniqueString suffix, so it
// goes into the repository variable AZURE_FRONTEND_STORAGE_ACCOUNT rather than a literal in CI.
output frontendStorageAccountName string = deployStaticSite ? staticSite!.outputs.storageAccountName : ''
// The gateway machine and browser traffic is moved onto. Empty until deployApim is set.
output apimGatewayUrl string = (deployApim && !empty(apiFlexSubnetId)) ? apim!.outputs.gatewayUrl : ''
// The VM every `az vm run-command invoke` addresses. Empty when the devbox is not deployed.
output devboxName string = (deployDevbox && !empty(devboxSubnetId)) ? devbox!.outputs.devboxName : ''
output searchEndpoint string = deploySearch ? search!.outputs.searchEndpoint : existingSearchEndpoint
output cosmosEndpoint string = cosmos.outputs.cosmosEndpoint
output identityClientId string = identity.outputs.clientId
output logAnalyticsWorkspaceName string = observability.outputs.workspaceName
output auditWorkspaceName string = auditLogs.outputs.workspaceName
// The query API addresses a workspace by this GUID, not by name or resource ID — so the future
// audit read endpoint needs it, and it is otherwise a portal lookup.
output auditWorkspaceCustomerId string = auditLogs.outputs.workspaceCustomerId
