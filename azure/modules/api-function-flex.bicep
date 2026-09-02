// DEMI REST API on Flex Consumption (FC1) — `demi-api-fc-<env>`, the only API app.
//
// Unlike extractor.bicep — whose header says its connection-string approach must not become the
// pattern — nothing here holds a storage key: the deployment container and the host's own
// bookkeeping both authenticate as the user-assigned identity.

@description('Location for Azure Function App resources')
param location string = resourceGroup().location

@description('Environment name (e.g. dev, test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

@description('OpenShift MinIO Endpoint URL')
param minioHost string

@description('OpenShift MinIO Access Key')
@secure()
param minioAccessKey string

@description('OpenShift MinIO Secret Key')
@secure()
param minioSecretKey string

@description('Azure AI Search endpoint, e.g. https://demi-search-test.search.windows.net. Empty disables chunk search rather than failing it.')
param searchEndpoint string = ''

// The three live index names, pinned to the code defaults in src/search/ai-search.js — a name the
// app reads but this template omits is DELETED by the whole-collection appSettings PUT.
@description('Azure AI Search index holding document chunks.')
param searchIndex string = 'chunks'

@description('Azure AI Search index holding project metadata.')
param searchIndexProjects string = 'projects'

@description('Azure AI Search index holding document metadata.')
param searchIndexDocuments string = 'documents'

@description('Foundry account endpoint for the AI summariser. Empty leaves the summary panel off rather than failing search.')
param foundryEndpoint string = ''

@description('Foundry model deployment name for the AI summariser')
param foundryDeployment string = ''

@description('Comma-separated `sources` keys a project may publish over HTTP. Empty publishes none.')
param enrichmentSources string = ''

@description('Master switch for the AI summariser. Off by default — a half-working summariser is worse than an absent one.')
param summaryEnabled bool = false

// Flex needs a subnet delegated to `Microsoft.App/environments`, min /27, not shared with private
// endpoints — so it cannot be the private-endpoint subnet.
@description('Delegated subnet for Flex VNet integration. Required: Cosmos, Key Vault and AI Search are all private-endpoint only.')
param virtualNetworkSubnetId string

@description('Resource ID of the user-assigned managed identity the app runs as')
param identityId string

@description('Client ID of that identity. DefaultAzureCredential cannot pick between several, so AZURE_CLIENT_ID names the one to use.')
param identityClientId string

@description('Principal ID of that identity. Granted the storage data-plane roles the Flex host needs.')
param identityPrincipalId string

@description('Cosmos DB for NoSQL document endpoint. Keyless — the identity above is the credential.')
param cosmosEndpoint string = ''

@description('Cosmos database holding the DEMI containers')
param cosmosDatabase string = 'demi'

@description('Object storage the API reads documents from. minio in dev; azure once Phase 3b lands.')
@allowed([ 'minio', 'azure' ])
param storageBackend string = 'minio'

@description('Public origin short links redirect from, e.g. https://projects.eao.gov.bc.ca. Per-environment: test must not hand back the prod host.')
param linkBaseUrl string = ''

@description('MinIO bucket holding the document corpus')
param minioBucketName string = 'eagle-demi'

@description('Key prefix within that bucket')
param minioKeyPrefix string = ''

@description('Key Vault URI of the break-glass sysadmin credential, INBOUND. Not the value: the app resolves it through a Key Vault reference.')
param adminApiKeySecretUri string

@description('OUTBOUND credential DEMI presents to docling-serve as X-Api-Key. Nothing inbound validates it.')
@secure()
param doclingApiKey string = ''

@description('Keycloak base URL for this environment (dev/test/prod loginproxy)')
param keycloakUrl string = environmentName == 'prod'
  ? 'https://loginproxy.gov.bc.ca/auth'
  : (environmentName == 'test' ? 'https://test.loginproxy.gov.bc.ca/auth' : 'https://dev.loginproxy.gov.bc.ca/auth')

@description('Keycloak realm')
param keycloakRealm string = 'eao-epic'

@description('Keycloak client whose tokens this API accepts.')
param keycloakClientId string = 'eagle-admin-console'

// Empty is permissive, and src/config.js refuses to boot test or prod on it — so an environment
// that forgets this setting fails loudly at startup instead of admitting every client in the realm.
@description('Comma-separated Keycloak client ids (token azp) permitted to call this API.')
param allowedClients string = ''

@description('Expected JWT aud claim. Empty disables audience verification.')
param ssoAudience string = ''

// Empty keys every visitor arriving through one of our proxies on that proxy's address, which is
// one shared anonymous bulk-download quota for all of them. src/utils/caller-ip.js.
@description('Comma-separated egress IPs of proxies we run (the OpenShift rproxy). For an APIM-asserted address on this list the browser hop of X-Forwarded-For is the caller.')
param trustedProxyIps string = ''

@description('Application Insights connection string. Empty disables telemetry, which is the local-development case.')
param appInsightsConnectionString string = ''

@description('Logs Ingestion endpoint of the audit DCR. Empty disables audit and analytics emission.')
param auditDcrEndpoint string = ''

@description('Immutable ID of the audit DCR. Both this and the endpoint are required before anything is sent.')
param auditDcrImmutableId string = ''

@description('Workspace GUID holding DemiAudit_CL and DemiEvents_CL. Empty makes GET /admin/audit and /admin/analytics answer 503.')
param auditWorkspaceCustomerId string = ''

@description('Workspace GUID holding AppRequests. Empty makes GET /admin/analytics answer 503.')
param appLogsWorkspaceCustomerId string = ''

@description('Name of the monthly budget read by GET /admin/cost. Empty omits the budget from the answer; the spend figures still come back.')
param budgetName string = ''

@description('Resource id of the demi-audit-<env> workspace. Empty skips deploy-access auditing rather than failing the deployment.')
param auditWorkspaceId string = ''

@description('Frontend hostnames (no scheme) allowed to call this API, as browser origins. An ARRAY because a cutover has two. Empty leaves CORS_ORIGIN unset, which is fail-closed.')
param frontendHostNames array = []

@description('Upstream eagle-api the seed loader reads. Must match the environment — the code default in src/seed/sources.js is the DEV instance.')
param eagleApiBase string

@description('NCRONTAB schedule for the nightly Eagle reconcile timer, e.g. `0 0 9 * * *`. Empty registers no timer at all.')
param reconcileSchedule string = ''

@description('Base URL of the Track API the team sync reads its project team members from. Empty leaves the sync with no upstream.')
param trackApiBase string = ''

@description('Keycloak client id of the Track service account (client credentials).')
param trackClientId string = ''

@description('Key Vault URI of the Track service account secret. Not the value: the app resolves it through a Key Vault reference.')
param trackClientSecretUri string

@description('Keycloak client id of the realm-management service account the team sync grants project roles with.')
param roleSyncClientId string = ''

@description('Key Vault URI of that service account secret. Same handling as trackClientSecretUri.')
param roleSyncClientSecretUri string

@description('eagle-notify base URL a published Update is announced to. Empty leaves the push dark.')
param notifyApiBase string = ''

@description('Key Vault URI of the eagle-notify function key. Not the value: the app resolves it through a Key Vault reference. Empty leaves the push dark.')
param notifyApiKeySecretUri string = ''

// @secure() only to satisfy the linter's name heuristic — the value is a Key Vault reference, not
// a secret; the vault holds the secret itself.
@description('Key Vault reference for the APIM gateway secret. Empty disables the gateway trust branch.')
@secure()
param apimGatewaySecretRef string = ''

@description('NCRONTAB schedule for the Track team sync timer, e.g. `0 0 10 * * *`. Empty registers no timer.')
param syncTeamsSchedule string = ''

// ── Bulk download ────────────────────────────────────────────────────────────
// Flex trap: an app setting deployed as '' is DROPPED, so `process.env.X` is undefined rather
// than empty — off is the code's default, never a value it can read here.
@description('Storage queue the bulk-download worker triggers on. Empty registers no worker, which leaves the feature off.')
param bulkDownloadsQueue string = ''

@description('Most documents one authenticated bulk job may ask for. Over it, the request is refused rather than truncated.')
param bulkMaxDocuments int = 2500

@description('Same cap for anonymous callers.')
param bulkAnonMaxDocuments int = 100

@description('Bytes per zip part. A job larger than this splits into numbered parts.')
param bulkMaxBytes int = 2147483648

@description('Bytes across all parts of one job. Over it, the request is refused.')
param bulkMaxTotalBytes int = 21474836480

@description('Unfinished jobs one requester may hold. The abuse boundary for the anonymous path — APIM Consumption cannot rate-limit by key.')
param bulkMaxPending int = 3

@description('Days a built zip stays downloadable.')
param bulkZipRetentionDays int = 7

@description('Days the job row lives. Longer than the zip retention, so the sweep still sees the row that owns an expired zip.')
param bulkJobTtlDays int = 30

@description('Jobs one requester may start in 24 hours. Concurrency alone does not bound a caller who waits for each job to finish.')
param bulkMaxPerDay int = 20

@description('Milliseconds a queued job may wait before the worker refuses it. The job row carries an access snapshot, and a stale one is credentials nobody has re-checked.')
param bulkMaxJobAgeMs int = 7200000

@description('NCRONTAB schedule for the zip cleanup timer, e.g. `0 30 3 * * *`. Empty registers no timer.')
param bulkCleanupSchedule string = ''

// Feature on means cleanup on: a queue with no sweep fills the container with zips nothing
// deletes. An explicit schedule still wins, so an environment can move the hour.
var cleanupSchedule = empty(bulkCleanupSchedule) && !empty(bulkDownloadsQueue)
  ? '0 30 3 * * *'
  : bulkCleanupSchedule

var apiAppName = 'demi-api-fc-${environmentName}'
var appServicePlanName = 'demi-plan-fc-${environmentName}'
var storageAccountName = take('demifc${environmentName}${uniqueString(resourceGroup().id)}', 24)

// Built-in data-plane roles the Flex host needs on its own storage account: blobs carry the
// deployment package and the host's leases, queues and tables its bookkeeping. All three, because
// AzureWebJobsStorage below is identity-based rather than a connection string.
var blobDataOwnerRoleId = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
var queueDataContributorRoleId = '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
var tableDataContributorRoleId = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'

resource apiStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: apiStorage
  name: 'default'
}

// Flex Consumption publishes here rather than to a site filesystem — there is no Kudu wwwroot.
resource deployContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'deployment'
}

resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' = if (!empty(bulkDownloadsQueue)) {
  parent: apiStorage
  name: 'default'
}

// Bulk-download job ids waiting to be zipped. One id per message. NAMED FROM THE PARAM: a queue
// declared under a different name than the worker triggers on is a feature that silently does
// nothing, and an environment with no queue name deploys neither queue.
resource bulkDownloadsQueueResource 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = if (!empty(bulkDownloadsQueue)) {
  parent: queueService
  name: bulkDownloadsQueue
}

// The runtime creates this itself after `maxDequeueCount` failed attempts. Declaring it means it
// exists from the start and can be alerted on, rather than appearing the first time a job dies.
resource bulkDownloadsPoison 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = if (!empty(bulkDownloadsQueue)) {
  parent: queueService
  name: '${bulkDownloadsQueue}-poison'
}

resource blobDataOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: apiStorage
  name: guid(apiStorage.id, identityPrincipalId, blobDataOwnerRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataOwnerRoleId)
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource queueDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: apiStorage
  name: guid(apiStorage.id, identityPrincipalId, queueDataContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', queueDataContributorRoleId)
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource tableDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: apiStorage
  name: guid(apiStorage.id, identityPrincipalId, tableDataContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableDataContributorRoleId)
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// One app per plan: a Flex plan cannot be shared, so there is no "join an existing plan" parameter.
resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: appServicePlanName
  location: location
  tags: tags
  kind: 'functionapp'
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  properties: {
    reserved: true // Linux
  }
}

resource apiFunctionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: apiAppName
  location: location
  tags: tags
  kind: 'functionapp,linux'
  // USER-assigned: the identity outlives the app, so its Cosmos, Search and Storage grants survive
  // a redeploy and can be made before the app exists.
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    virtualNetworkSubnetId: virtualNetworkSubnetId
    // Key Vault references resolve as the SYSTEM-assigned identity unless told otherwise, and this
    // app has none — without this line ADMIN_API_KEY stays an unresolved literal and admin calls 401.
    keyVaultReferenceIdentity: identityId
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${apiStorage.properties.primaryEndpoints.blob}${deployContainer.name}'
          authentication: {
            type: 'UserAssignedIdentity'
            userAssignedIdentityResourceId: identityId
          }
        }
      }
      // 20 instances caps the bill; nothing measured needs more. `alwaysReady: []` is scale to
      // zero — cold start is measured before the prod flip, and one always-ready instance is the
      // knob if it is too slow.
      scaleAndConcurrency: {
        maximumInstanceCount: 20
        instanceMemoryMB: 2048
        alwaysReady: []
      }
      runtime: {
        name: 'node'
        version: '22'
      }
    }
    siteConfig: {
      minTlsVersion: '1.2'
      // WHOLE-COLLECTION PUT: a setting that exists on the live app but is absent from this list is
      // DELETED by the next deploy. Everything the app reads is declared here, empty values
      // included. No FUNCTIONS_WORKER_RUNTIME, FUNCTIONS_EXTENSION_VERSION,
      // WEBSITE_NODE_DEFAULT_VERSION or WEBSITE_RUN_FROM_PACKAGE: Flex takes the runtime from
      // `functionAppConfig.runtime` and rejects those four.
      appSettings: [
        // src/controllers/config.js falls back to DEV values for both of these — pin them per app.
        {
          name: 'ENVIRONMENT'
          value: environmentName
        }
        // Identity-based, so no account key lands in app settings. The three role assignments above
        // are what make it work; without them the host cannot start.
        {
          name: 'AzureWebJobsStorage__accountName'
          value: apiStorage.name
        }
        {
          name: 'AzureWebJobsStorage__credential'
          value: 'managedidentity'
        }
        {
          name: 'AzureWebJobsStorage__clientId'
          value: identityClientId
        }
        // The Functions host emits request and dependency telemetry from this; api/index.js reads
        // the same variable to decide whether to start the OpenTelemetry distro.
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: appInsightsConnectionString
        }
        // The distro in application code owns instrumentation; the platform agent as well would
        // double-count telemetry.
        {
          name: 'APPLICATIONINSIGHTS_ENABLE_AGENT'
          value: 'false'
        }
        // DefaultAzureCredential has no way to choose between several user-assigned identities.
        {
          name: 'AZURE_CLIENT_ID'
          value: identityClientId
        }
        {
          name: 'COSMOS_ENDPOINT'
          value: cosmosEndpoint
        }
        {
          name: 'COSMOS_NOSQL_DATABASE'
          value: cosmosDatabase
        }
        {
          name: 'MINIO_HOST'
          value: minioHost
        }
        {
          name: 'MINIO_ACCESS_KEY'
          value: minioAccessKey
        }
        {
          name: 'MINIO_SECRET_KEY'
          value: minioSecretKey
        }
        {
          name: 'MINIO_BUCKET_NAME'
          value: minioBucketName
        }
        {
          name: 'MINIO_KEY_PREFIX'
          value: minioKeyPrefix
        }
        {
          name: 'MINIO_PORT'
          value: '443'
        }
        {
          name: 'MINIO_USE_SSL'
          value: 'true'
        }
        // Per environment — test must hand back the test host, not prod's.
        {
          name: 'LINK_BASE_URL'
          value: linkBaseUrl
        }
        {
          name: 'STORAGE_BACKEND'
          value: storageBackend
        }
        // Absent, src/seed/sources.js falls back to its hardcoded eagle-DEV URL — silently
        // repointing this environment's seed at dev data.
        {
          name: 'EAGLE_API_BASE'
          value: eagleApiBase
        }
        // api/index.js registers the timer only when this is set, and the host resolves the
        // schedule out of it as `%RECONCILE_SCHEDULE%`. Empty is off.
        {
          name: 'RECONCILE_SCHEDULE'
          value: reconcileSchedule
        }
        // ADMIN_API_KEY — not DOCLING_API_KEY — is what the admin endpoints check. Resolves through
        // the UAMI (keyVaultReferenceIdentity) over the vault private endpoint.
        {
          name: 'ADMIN_API_KEY'
          value: '@Microsoft.KeyVault(SecretUri=${adminApiKeySecretUri})'
        }
        {
          name: 'DOCLING_API_KEY'
          value: doclingApiKey
        }
        {
          name: 'TRACK_API_BASE'
          value: trackApiBase
        }
        {
          name: 'TRACK_CLIENT_ID'
          value: trackClientId
        }
        {
          name: 'TRACK_CLIENT_SECRET'
          value: '@Microsoft.KeyVault(SecretUri=${trackClientSecretUri})'
        }
        // eagle-notify. BOTH are required before anything is sent — src/services/notify.js is
        // dark on either being empty, and the mirror then takes no notification claim at all.
        {
          name: 'NOTIFY_API_BASE'
          value: notifyApiBase
        }
        {
          name: 'NOTIFY_API_KEY'
          value: empty(notifyApiKeySecretUri) ? '' : '@Microsoft.KeyVault(SecretUri=${notifyApiKeySecretUri})'
        }
        // The realm-management service account the sync grants `project:<id>` roles with. Distinct
        // from KEYCLOAK_CLIENT_ID, which is the client whose user tokens this API accepts.
        {
          name: 'KEYCLOAK_ADMIN_CLIENT_ID'
          value: roleSyncClientId
        }
        {
          name: 'KEYCLOAK_ADMIN_CLIENT_SECRET'
          value: '@Microsoft.KeyVault(SecretUri=${roleSyncClientSecretUri})'
        }
        {
          name: 'SYNC_TEAMS_SCHEDULE'
          value: syncTeamsSchedule
        }
        // Bulk download. api/index.js registers the queue worker only when the queue name is set,
        // and the host resolves it as `%BULK_DOWNLOADS_QUEUE%`. Empty is off — and Flex drops an
        // empty value entirely, so the code reads `undefined` here, not ''.
        {
          name: 'BULK_DOWNLOADS_QUEUE'
          value: bulkDownloadsQueue
        }
        {
          name: 'BULK_MAX_DOCUMENTS'
          value: string(bulkMaxDocuments)
        }
        {
          name: 'BULK_ANON_MAX_DOCUMENTS'
          value: string(bulkAnonMaxDocuments)
        }
        {
          name: 'BULK_MAX_BYTES'
          value: string(bulkMaxBytes)
        }
        {
          name: 'BULK_MAX_TOTAL_BYTES'
          value: string(bulkMaxTotalBytes)
        }
        {
          name: 'BULK_MAX_PENDING'
          value: string(bulkMaxPending)
        }
        {
          name: 'BULK_ZIP_RETENTION_DAYS'
          value: string(bulkZipRetentionDays)
        }
        {
          name: 'BULK_JOB_TTL_DAYS'
          value: string(bulkJobTtlDays)
        }
        {
          name: 'BULK_MAX_PER_DAY'
          value: string(bulkMaxPerDay)
        }
        {
          name: 'BULK_MAX_JOB_AGE_MS'
          value: string(bulkMaxJobAgeMs)
        }
        {
          name: 'BULK_CLEANUP_SCHEDULE'
          value: cleanupSchedule
        }
        // What proves a request came through APIM. Empty is the off switch: helpers/auth.js then
        // ignores both gateway headers, which is the only safe default while the host is public.
        {
          name: 'APIM_GATEWAY_SECRET'
          value: apimGatewaySecretRef
        }
        // No key: AI Search has disableLocalAuth, so the app authenticates with the same identity
        // it uses for Cosmos. Absent endpoint degrades the chunk dataset to empty results.
        {
          name: 'SEARCH_ENDPOINT'
          value: searchEndpoint
        }
        {
          name: 'SEARCH_INDEX'
          value: searchIndex
        }
        {
          name: 'SEARCH_INDEX_PROJECTS'
          value: searchIndexProjects
        }
        {
          name: 'SEARCH_INDEX_DOCUMENTS'
          value: searchIndexDocuments
        }
        {
          name: 'ENRICHMENT_SOURCES'
          value: enrichmentSources
        }
        {
          name: 'SUMMARY_ENABLED'
          // NOT string(summaryEnabled): ARM stringifies booleans as 'True'/'False', and
          // src/config.js compares === 'true'.
          value: summaryEnabled ? 'true' : 'false'
        }
        {
          name: 'FOUNDRY_ENDPOINT'
          value: foundryEndpoint
        }
        {
          name: 'FOUNDRY_DEPLOYMENT'
          value: foundryDeployment
        }
        // Audit and usage analytics. Absent endpoint drops events after a single warning rather
        // than throwing, which is what makes local development and the test suite work.
        {
          name: 'AUDIT_DCR_ENDPOINT'
          value: auditDcrEndpoint
        }
        {
          name: 'AUDIT_DCR_IMMUTABLE_ID'
          value: auditDcrImmutableId
        }
        // Reading the same data back for the admin panel. The query API keys on the workspace
        // GUID, not the resource id, so this is not auditWorkspaceId above.
        {
          name: 'AUDIT_WORKSPACE_CUSTOMER_ID'
          value: auditWorkspaceCustomerId
        }
        {
          name: 'APP_LOGS_WORKSPACE_CUSTOMER_ID'
          value: appLogsWorkspaceCustomerId
        }
        // This resource group, which is the scope both the cost query and the budget read at.
        {
          name: 'COST_SCOPE'
          value: resourceGroup().id
        }
        {
          name: 'BUDGET_NAME'
          value: budgetName
        }
        // Keycloak / SSO — MUST be pinned per environment. Without these the API falls back to
        // src/config.js defaults, which point at the DEV realm.
        {
          name: 'KEYCLOAK_URL'
          value: keycloakUrl
        }
        {
          name: 'KEYCLOAK_REALM'
          value: keycloakRealm
        }
        {
          name: 'KEYCLOAK_CLIENT_ID'
          value: keycloakClientId
        }
        {
          name: 'KEYCLOAK_ENABLED'
          value: 'true'
        }
        {
          name: 'DEMI_ALLOWED_CLIENTS'
          value: allowedClients
        }
        {
          name: 'SSO_ISSUER'
          value: '${keycloakUrl}/realms/${keycloakRealm}'
        }
        {
          name: 'SSO_JWKSURI'
          value: '${keycloakUrl}/realms/${keycloakRealm}/protocol/openid-connect/certs'
        }
        {
          name: 'SSO_AUDIENCE'
          value: ssoAudience
        }
        // Comma-separated, which is what the CORS guard splits on. An empty array joins to '',
        // which falls back to localhost only — no browser origin, rather than any browser origin.
        {
          name: 'CORS_ORIGIN'
          value: join(map(frontendHostNames, h => 'https://${h}'), ',')
        }
        // Flex routes all outbound traffic through the integrated subnet on its own, so this is
        // inert here — kept because it costs nothing and a wrong guess about that is a total
        // outage: every private endpoint would resolve public and be refused.
        {
          name: 'WEBSITE_VNET_ROUTE_ALL'
          value: '1'
        }
        // THE LANDING ZONE'S resolver, not Azure's platform default 168.63.129.16. The privatelink
        // zones live in a central subscription reachable only through the hub resolver; with the
        // default, Cosmos and Search resolve to PUBLIC addresses and every call is rejected.
        {
          name: 'WEBSITE_DNS_SERVER'
          value: '10.53.244.4'
        }
        {
          name: 'AzureWebJobsFeatureFlags'
          value: 'EnableWorkerIndexing'
        }
        {
          name: 'TRUSTED_PROXY_IPS'
          value: trustedProxyIps
        }
      ]
      // Platform-level CORS, in front of the app's own, and it answers the preflight itself — so
      // adding a host to CORS_ORIGIN alone is not enough. portal.azure.com keeps the built-in test
      // console working.
      cors: {
        allowedOrigins: concat(
          [ 'https://portal.azure.com' ],
          map(frontendHostNames, h => 'https://${h}')
        )
      }
    }
  }
}

// `<app>.scm.azurewebsites.net` is internet-reachable and answers 401 rather than refusing, so
// leaving basic auth on is an unthrottled credential-guessing surface. Nothing authenticates that
// way: CI logs in with OIDC and publishes with `az functionapp deployment source config-zip`.
resource apiScmBasicAuth 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: apiFunctionApp
  name: 'scm'
  properties: {
    allow: false
  }
}

resource apiFtpBasicAuth 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: apiFunctionApp
  name: 'ftp'
  properties: {
    allow: false
  }
}

// Who authenticated to SCM and deployed — the one authenticated change that never passes through
// the app's own audit trail. Into the AUDIT workspace: demi-logs stops collecting at its
// dailyQuotaGb, and a record a busy day can drop is not an audit record.
resource apiAuditDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(auditWorkspaceId)) {
  scope: apiFunctionApp
  // Distinctly named: the landing zone sets its own `setByPolicy-*` settings here, and a colliding
  // name would have the two overwrite each other on every deploy.
  name: 'demi-audit'
  properties: {
    workspaceId: auditWorkspaceId
    logs: [
      {
        category: 'AppServiceAuditLogs'
        enabled: true
      }
    ]
  }
}

output apiFunctionAppName string = apiFunctionApp.name
output apiFunctionAppHostName string = apiFunctionApp.properties.defaultHostName
output storageAccountName string = apiStorage.name
