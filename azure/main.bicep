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
// PARAMETERS here. `modules/vnet.bicep` is left in the tree unreferenced rather than deleted,
// because it is the only written record of the topology this was designed against before the
// landing zone supplied one — but instantiating it would build a second, disconnected network.
//
// WHAT IS DELIBERATELY ABSENT.
//   - Key Vault. Never deployed; secrets are app settings. `modules/key-vault.bicep` is unreferenced.
//   - Static Web App. The frontend is an App Service (`demi-frontend-dev`), not a SWA.
//     `modules/static-web-app.bicep` is unreferenced and superseded by `frontend-web-app.bicep`.
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

// These two reach app settings directly (api-web-app.bicep). Until now main.bicep did not pass them
// at all, so the module default of '' applied and the first successful deploy would have written
// ADMIN_API_KEY='' and DOCLING_API_KEY='' over the live values — destroying the break-glass
// credential and the extraction host's key. `what-if` cannot surface that, because @secure() values
// are masked in its output, which is why it stayed invisible through several reviews.
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

// Bucket and prefix were previously set out of band, so every template deploy silently reset them
// to the module defaults ('eagle-demi', ''). Exposed here so the template describes reality.
@description('Object-store bucket name (dev: asnpnn, test: zdspnb).')
param minioBucketName string = 'eagle-demi'

@description('Key prefix namespacing this environment inside the bucket.')
param minioKeyPrefix string = ''

@description('Monthly anomaly guard in CAD — the subscription\'s billing currency. Roughly 3x the measured run rate (18.71 CAD over 12 days of August 2026). The absolute annual ceiling is a separate parameter; see cost-budget.bicep for why one number cannot be both.')
param budgetAmount int = 150

@description('Absolute annual ceiling in CAD. Not a target — see cost-budget.bicep.')
param annualCeiling int = 50000

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

@description('Existing landing-zone subnet for App Service VNet integration (c4b0a8-dev-networking).')
param appServiceSubnetId string = ''

@description('Object ID of a human principal granted read access to data planes. Empty grants none.')
param readerPrincipalId string = ''

// Phase 3b. The module is written and the argument for it is per-environment isolation rather than
// cost, but nothing is deployed and nothing is copied — and turning it on needs `Storage Blob
// Delegator` on the identity or every download link fails to sign, which is NOT implied by
// `Storage Blob Data Contributor`. Off, so that this file keeps describing what exists.
@description('Deploy the Phase 3b document storage account. Off: dev still reads MinIO.')
param deployDocumentStorage bool = false

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
// foundry.bicep's header says to read that failure as "the PE already exists" and move on, which
// was true when nothing consumed the module's outputs. It no longer is: a Failed module means
// `foundry.outputs.foundryEndpoint` never resolves, so `deploy-api-web-app` never runs at all.
//
// So: false once the PE exists and is Approved, which reuses the module's existing
// `if (!empty(peSubnetId))` gate to skip re-PUTting a resource that is already correct. Leave it
// true for a fresh environment, where the PE has to be created and one failed run is the price.
@description('Create the Foundry private endpoint. Set false when it already exists — re-PUTting it races the account PUT and fails the whole deployment.')
param deployFoundryPrivateEndpoint bool = true

// Mandatory Cost Management Tags applied across ALL resources
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
    // Control-plane auditing. This reverses the usual reading order — cosmos is module 2 and
    // auditLogs is module 6 — but Bicep orders on output references, not declaration, and
    // auditLogs depends only on identity and observability, so there is no cycle.
    auditWorkspaceId: auditLogs.outputs.workspaceId
  }
}

// 3. Azure AI Search — the Deep Search query layer. Basic tier, one replica, one partition.
module search './modules/ai-search.bicep' = {
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
    // Same list the budget alerts use — one place to change who gets told.
    contactEmails: contactEmails
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
module foundry './modules/foundry.bicep' = {
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

// 7. REST API — Linux App Service on a B1 plan, integrated into the landing-zone subnet.
//
// Not Consumption (Y1) despite `kind: 'functionapp'`: the live plan is B1, because the app holds a
// warm worker and the 224 MB heap ceiling the scripts are written against is a B1 instance.
module apiWebApp './modules/api-web-app.bicep' = {
  name: 'deploy-api-web-app'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
    minioHost: minioHost
    minioAccessKey: minioAccessKey
    minioSecretKey: minioSecretKey
    minioBucketName: minioBucketName
    minioKeyPrefix: minioKeyPrefix
    adminApiKey: adminApiKey
    doclingApiKey: doclingApiKey
    eagleApiBase: eagleApiBase
    apiSubnetId: appServiceSubnetId
    identityId: identity.outputs.identityId
    identityClientId: identity.outputs.clientId
    cosmosEndpoint: cosmos.outputs.cosmosEndpoint
    searchEndpoint: search.outputs.searchEndpoint
    appInsightsConnectionString: observability.outputs.connectionString
    summaryEnabled: summaryEnabled
    foundryEndpoint: foundry.outputs.foundryEndpoint
    foundryDeployment: foundry.outputs.deploymentName
    auditDcrEndpoint: auditLogs.outputs.dcrEndpoint
    auditDcrImmutableId: auditLogs.outputs.dcrImmutableId
    // Deploy-access auditing: who signed in to Kudu/SCM and published.
    auditWorkspaceId: auditLogs.outputs.workspaceId
  }
}

// 8. Angular frontend — a second Linux App Service on its own B1 plan.
module frontendWebApp './modules/frontend-web-app.bicep' = {
  name: 'deploy-frontend-web-app'
  params: {
    location: location
    environmentName: environmentName
    tags: defaultTags
    appInsightsConnectionString: observability.outputs.connectionString
  }
}

// 9. Cost budget alerts. AI Search Basic is a fixed monthly charge whether queried or idle, which
// is what moved the ceiling to 100.
module costBudget './modules/cost-budget.bicep' = {
  name: 'deploy-cost-budget'
  params: {
    environmentName: environmentName
    budgetAmount: budgetAmount
    annualCeiling: annualCeiling
    contactEmails: contactEmails
  }
}

// Outputs
output apiWebAppHostName string = apiWebApp.outputs.apiWebAppHostName
output frontendWebAppHostName string = frontendWebApp.outputs.frontendWebAppHostName
output searchEndpoint string = search.outputs.searchEndpoint
output cosmosEndpoint string = cosmos.outputs.cosmosEndpoint
output identityClientId string = identity.outputs.clientId
output logAnalyticsWorkspaceName string = observability.outputs.workspaceName
output auditWorkspaceName string = auditLogs.outputs.workspaceName
// The query API addresses a workspace by this GUID, not by name or resource ID — so the future
// audit read endpoint needs it, and it is otherwise a portal lookup.
output auditWorkspaceCustomerId string = auditLogs.outputs.workspaceCustomerId
