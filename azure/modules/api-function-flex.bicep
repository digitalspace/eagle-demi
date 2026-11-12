// DEMI REST API on Flex Consumption (FC1), `demi-api-fc-<env>`. No storage key: deployment and
// host bookkeeping authenticate as the user-assigned identity.

@description('Location for Azure Function App resources')
param location string = resourceGroup().location

@description('Environment name (e.g. dev, test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

@description('OpenShift MinIO Endpoint URL')
param minioHost string

@description('Key Vault URI of the object-store access key. Not the value: the app resolves it through a Key Vault reference.')
param minioAccessKeySecretUri string

@description('Key Vault URI of the object-store secret key. Same handling as minioAccessKeySecretUri.')
param minioSecretKeySecretUri string

@description('Azure AI Search endpoint, e.g. https://demi-search-test.search.windows.net. Empty disables chunk search rather than failing it.')
param searchEndpoint string = ''

// The five live index names, pinned to the code defaults in src/search/ai-search.js — a name the
// app reads but this template omits is DELETED by the whole-collection appSettings PUT.
@description('Azure AI Search index holding document chunks.')
param searchIndex string = 'chunks'

@description('Azure AI Search index holding project metadata.')
param searchIndexProjects string = 'projects'

@description('Azure AI Search index holding document metadata.')
param searchIndexDocuments string = 'documents'

// Empty is the kill switch for these two: keyword searches fall back to a Cosmos CONTAINS read.
// Set the index name only after the index PUT and the first indexer run.
@description('Azure AI Search index holding recent activity (updates). Empty falls back to Cosmos.')
param searchIndexActivities string = ''

// Set to the index name only after the index PUT and the first indexer run.
@description('Azure AI Search index holding project notifications. Empty falls back to Cosmos.')
param searchIndexProjectNotifications string = ''

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

@description('Key Vault URI of the OUTBOUND credential DEMI presents to docling-serve as X-Api-Key. Nothing inbound validates it.')
param doclingApiKeySecretUri string

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

// Who may write the Eagle mirror (PUT /eagle/*). Empty refuses everyone rather than admitting
// every writer, so blanking it closes the mirror.
@description('Comma-separated registry row ids permitted on PUT /eagle/*.')
param eagleMirrorPrincipals string = 'apim:eagle-api'

// Who may call the PDF title worker routes. Empty refuses everyone. Keep it disjoint from
// eagleMirrorPrincipals.
@description('Comma-separated registry row ids permitted on the PDF title worker routes.')
param pdfTitleWorkerPrincipals string = ''

@description('Storage account holding the Archive backup the PDF title writes are checked against. Empty keeps the gate closed.')
param backupAccountName string = ''

@description('Container in backupAccountName holding the backed-up originals. Empty keeps the gate closed.')
param backupContainerName string = ''

@description('Expected JWT aud claim. Empty disables audience verification.')
param ssoAudience string = ''

// Empty keys every visitor arriving through one of our proxies on that proxy's address, which is
// one shared anonymous bulk-download quota for all of them. src/utils/caller-ip.js.
@description('Comma-separated egress IPs of proxies we run (the OpenShift rproxy). For an APIM-asserted address on this list the browser hop of X-Forwarded-For is the caller.')
param trustedProxyIps string = ''

// Empty keys every visitor arriving through Front Door on its egress address, which is one shared
// anonymous bulk-download quota for all of them. src/utils/caller-ip.js.
@description('Key Vault URI of the shared secret the eagle-edge rule set stamps as X-Edge-Secret. Not the value: the app resolves it through a Key Vault reference, and it is also passed plain as EDGE_SECRET_URI. Empty ignores the header.')
param edgeSecretUri string = ''

@description('EDGE_GATE for src/http/router.js: empty off, log serves and writes one warn line per request that skipped Front Door, enforce answers 403.')
@allowed(['', 'log', 'enforce'])
param edgeGate string = ''

// The edge ban detector (src/scripts/edge-ban.js), timer `edgeBan` in api/index.js.
@description('EDGE_BAN_MODE: off writes the placeholder back to the Front Door ban rule (the kill switch), shadow records would-bans only, write records them and updates the rule.')
@allowed(['off', 'shadow', 'write'])
param edgeBanMode string = 'off'

@description('NCRONTAB schedule for the edge ban timer, six fields.')
param edgeBanSchedule string = '0 0 * * * *'

@description('Key Vault URI of the `edge-ban-policy` secret (thresholds and allow list, JSON). Not the value: the app resolves it through a Key Vault reference. Empty skips every shadow or write tick; off needs none.')
param edgeBanPolicySecretUri string = ''

@description('Log Analytics workspace holding the Front Door access log, in the eagle-edge resource group. Empty skips every tick, off included.')
param edgeLogWorkspaceId string = ''

@description('Resource id of the `banauto` rule in the eagle-edge `rulesdemidocs` rule set. Empty skips every tick, off included.')
param edgeBanRuleId string = ''

// Empty leaves POST /api/gate answering 404, which is what an ungated environment wants. The
// boolean the browser reads is ACCESS_GATE in the `public` config document, not this.
@description('Key Vault URI of the password POST /api/gate accepts. Not the value: the app resolves it through a Key Vault reference. Empty leaves the site ungated.')
param accessGateSecretUri string = ''

@description('Application Insights connection string. Empty disables telemetry, which is the local-development case.')
param appInsightsConnectionString string = ''

@description('Logs Ingestion endpoint of the audit DCR. Empty disables audit and analytics emission.')
param auditDcrEndpoint string = ''

@description('Immutable ID of the audit DCR. Both this and the endpoint are required before anything is sent.')
param auditDcrImmutableId string = ''

@description('Workspace GUID holding DemiAudit_CL and DemiEvents_CL. Empty makes GET /admin/audit and /admin/analytics answer 503.')
param auditWorkspaceCustomerId string = ''

// The audit repoint. With both set, privileged actions are written to EagleAudit_CL in the
// eagle-analytics pipeline instead of DemiAudit_CL; usage counters stay on the DEMI DCR either way.
@description('Logs Ingestion endpoint of analytics-dcr-<env>. Empty keeps audit rows on the DEMI DCR.')
param analyticsDcrEndpoint string = ''

@description('Immutable ID of that DCR. Both this and the endpoint are required before anything is repointed — a mismatched pair is rejected at ingest.')
param analyticsDcrImmutableId string = ''

@description('Workspace GUID of analytics-logs-<env>, holding EagleAudit_CL. Empty makes GET /admin/audit read DemiAudit_CL alone.')
param analyticsWorkspaceCustomerId string = ''

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

@description('Mirror every public Track work type and its milestones in the nightly sync. Off until the public read ships.')
param trackWorksSync bool = false

@description('Write every Track work into the `works` container in the nightly sync. Off until test has proven it.')
param worksWrite bool = false

@description('Compose project works from the `works` container instead of the project row. Off until the parity check passes.')
param worksRead bool = false

@description('Date the assessments of every project from its documents, comment periods and Track phases in the nightly sync. Off until test has proven it.')
param assessmentPass bool = false

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

@description('Update emails link /updates/<id> instead of the project page. See main.bicep.')
param notifyUpdateReaderLinks bool = false

@description('Sorts on an Update\'s publishDate run on dateAdded until the backfill has run. See main.bicep.')
param updatesPublishDateFallback bool = true

@description('NCRONTAB schedule for the scheduled-Update announce timer. Empty derives one from notifyApiBase.')
param announceUpdatesSchedule string = ''

// @secure() only to satisfy the linter's name heuristic — the value is a Key Vault reference, not
// a secret; the vault holds the secret itself.
@description('Key Vault reference for the APIM gateway secret. Empty disables the gateway trust branch.')
@secure()
param apimGatewaySecretRef string = ''

@description('Versionless vault URI of apim-gateway-secret, read by the app itself with its -standby twin. Empty turns the vault read off.')
param apimGatewaySecretUri string = ''

@description('NCRONTAB schedule for the Track team sync timer, e.g. `0 0 10 * * *`. Empty registers no timer.')
param syncTeamsSchedule string = ''

@description('NCRONTAB schedule for the Track project poll timer, e.g. `0 */5 * * * *`. Empty registers no timer.')
param syncProjectsSchedule string = ''

// Bulk download. Flex drops an app setting deployed as '', so the code reads undefined, not
// empty: off is the code's default.
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

@description('Object opens the worker keeps ahead of the archive append, so the next documents overlap the current one. Sockets and buffers in flight per instance.')
param bulkFetchAhead int = 3

@description('Objects READ at once, the entry being appended included. 1 keeps the transfers serial, which is what bulkFetchAhead alone does; above 1 it supersedes bulkFetchAhead. One connection to NRS carries about 6.4 MB/s.')
param bulkFetchConcurrency int = 1

@description('Bytes those concurrent reads hold in total, split evenly between them. The memory this trades for the throughput, on top of the one 64 MiB multipart upload buffer.')
param bulkFetchBufferBytes int = 268435456

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

// ── Chunk parent-field re-stamping ───────────────────────────────────────────
@description('Storage queue the chunk parent-field re-stamp worker triggers on. Empty registers no worker, and the document write then skips the re-stamp.')
param chunkRestampQueue string = ''

// ── Search definition apply ──────────────────────────────────────────────────
@description('Storage queue the search definition apply worker triggers on, e.g. `search-definitions`. Empty registers no worker and POST /admin/search-definitions/apply answers 503.')
param searchDefinitionsQueue string = ''

@description('Resource id of the user-assigned identity the search service runs its indexers as. Written into every data source the apply PUTs, so an empty value makes the indexer fail its next run on "Ensure managed identity is enabled".')
param dataSourceIdentityId string = ''

// ── Sync-out to eagle-api ────────────────────────────────────────────────────
@description('Storage queue the sync-out worker triggers on, e.g. `sync-out`. Empty registers no worker.')
param syncOutQueue string = ''

@description('Send DEMI-owned comment periods on to eagle-api. Off until the cutover turns it on.')
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

@description('eagle-api base the sync-out consumer writes to, e.g. https://eagle-test.apps.silver.devops.gov.bc.ca/api. Not eagleApiBase, which is the public read path.')
param eagleProtectedApiBase string = ''

@description('ENGAGE public API base, e.g. https://epic-engage-web-test.apps.gold.devops.gov.bc.ca/api. Empty skips the ENGAGE side of both reconciles.')
param engageApiBase string = ''

@description('Comma-separated registry row ids permitted on PUT /engage/*. Empty refuses every writer.')
param engagePrincipals string = 'apim:engage'

@description('Comma-separated registry row ids permitted on PUT and DELETE under /track/*. Empty refuses every writer.')
param trackPrincipals string = 'apim:track'

@description('NCRONTAB schedule for the ENGAGE reconcile timer. Empty registers no timer.')
param reconcileEngageSchedule string = ''

@description('Key Vault URI of the `demi-sync-out` Keycloak client secret. Empty leaves EAGLE_KC_CLIENT_SECRET blank.')
param syncOutEagleClientSecretUri string = ''

@description('Eagle milestone id the consumer sends on every comment period write; eagle-api replaces a missing one with a new ObjectId.')
param eagleEngageMilestone string = ''

// ── Document intake ──────────────────────────────────────────────────────────
// All empty when intake is not deployed; the intake functions register only when these are set.
@description('Intake staging account name. Empty leaves intake off.')
param intakeStorageAccount string = ''

param intakeIncomingContainer string = ''

param intakeQuarantineContainer string = ''

@description('Resource id of demi-intake-<env>, attached as a second identity for the scan-result tag reads and the quarantine copy')
param intakeIdentityId string = ''

@description('Client id of demi-intake-<env>')
param intakeIdentityClientId string = ''

@description('Defender scan cap in GB per month. The sweep reports usage against it.')
param intakeCapGBPerMonth int = 0

// eagle-notify wired means the announce on: eagle-api never pushes again when a scheduled Update
// goes live, so without the timer it would never reach subscribers. An explicit schedule wins.
var updatesAnnounceSchedule = empty(announceUpdatesSchedule) && !empty(notifyApiBase)
  ? '0 */5 * * * *'
  : announceUpdatesSchedule

// Feature on means cleanup on: a queue with no sweep fills the container with zips nothing
// deletes. An explicit schedule still wins, so an environment can move the hour.
var cleanupSchedule = empty(bulkCleanupSchedule) && !empty(bulkDownloadsQueue)
  ? '0 30 3 * * *'
  : bulkCleanupSchedule

// Both halves or neither: an endpoint with no immutable ID addresses no rule, and the app treats a
// half-set pair as OFF, which would silently discard every audit row.
var analyticsAuditConfigured = !empty(analyticsDcrEndpoint) && !empty(analyticsDcrImmutableId)

var apiAppName = 'demi-api-fc-${environmentName}'
var appServicePlanName = 'demi-plan-fc-${environmentName}'
var storageAccountName = take('demifc${environmentName}${uniqueString(resourceGroup().id)}', 24)

// Data-plane roles the Flex host needs on its own account (package and leases, queues, tables),
// because AzureWebJobsStorage below is identity-based, not a connection string.
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

// Opt out: new accounts inherit the subscription Defender for Storage plan (about 0.63 CAD a day each). Set isEnabled true to turn it back on for this account.
resource defenderForStorage 'Microsoft.Security/defenderForStorageSettings@2025-06-01' = {
  name: 'current'
  scope: apiStorage
  properties: {
    isEnabled: false
    overrideSubscriptionLevelSettings: true
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

// Managed-mode devbox runs write stdout/stderr here; the name must match OUT_CONTAINER in
// scripts/demi-devbox.sh. Operator roles are granted by hand; see the README devbox section.
resource devboxRunOutputContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'devbox-run-output'
}

// Encrypted works spreadsheet extracts for the devbox import. Ciphertext only, so the account's
// shared-key access is accepted; the app identity reads through blobDataOwner, operators by hand.
resource worksImportContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'works-import'
  properties: {
    publicAccess: 'None'
  }
}

// The account's only lifecycle policy. The trailing slash keeps the delete rule off every other
// container, including any whose name starts with works-import.
resource storageLifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: apiStorage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'works-import-expiry'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: ['blockBlob', 'appendBlob']
              prefixMatch: ['${worksImportContainer.name}/']
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterCreationGreaterThan: 7
                }
              }
              version: {
                delete: {
                  daysAfterCreationGreaterThan: 7
                }
              }
              snapshot: {
                delete: {
                  daysAfterCreationGreaterThan: 7
                }
              }
            }
          }
        }
      ]
    }
  }
}

// Shared by every queue below, so its condition is the OR of theirs — an environment that runs
// only one of the features still needs the service.
resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' = if (!empty(bulkDownloadsQueue) || !empty(chunkRestampQueue) || !empty(searchDefinitionsQueue) || !empty(syncOutQueue)) {
  parent: apiStorage
  name: 'default'
}

// Bulk-download job ids, one per message. Named from the param: a queue the worker does not
// trigger on silently does nothing, and no queue name deploys neither queue.
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

// Documents whose chunks need parent fields re-stamped, one id per message. Named from the param
// for the same reason as the bulk queue.
resource chunkRestampQueueResource 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = if (!empty(chunkRestampQueue)) {
  parent: queueService
  name: chunkRestampQueue
}

// Declared rather than left to the runtime, same as above: a message that has burned its
// `maxDequeueCount` is a document whose chunks are stale, and the queue has to exist to be watched.
resource chunkRestampPoison 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = if (!empty(chunkRestampQueue)) {
  parent: queueService
  name: '${chunkRestampQueue}-poison'
}

// Search definition apply jobs waiting to run. One job id per message, and the row the id names is
// re-read by the worker — a redelivery cannot change what was asked for.
resource searchDefinitionsQueueResource 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = if (!empty(searchDefinitionsQueue)) {
  parent: queueService
  name: searchDefinitionsQueue
}

// Declared rather than left to the runtime: an apply that burned its attempts left the search
// service part-way through a definition change, which is the message a human has to see.
resource searchDefinitionsPoison 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = if (!empty(searchDefinitionsQueue)) {
  parent: queueService
  name: '${searchDefinitionsQueue}-poison'
}

// Comment periods waiting to be sent to eagle-api. One row id per message; the consumer re-reads the row.
resource syncOutQueueResource 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = if (!empty(syncOutQueue)) {
  parent: queueService
  name: syncOutQueue
}

// Declared so it exists to be watched: a message here is a period Eagle never received.
resource syncOutPoison 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = if (!empty(syncOutQueue)) {
  parent: queueService
  name: '${syncOutQueue}-poison'
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
    userAssignedIdentities: union(
      { '${identityId}': {} },
      empty(intakeIdentityId) ? {} : { '${intakeIdentityId}': {} }
    )
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
      // 20 instances caps the bill. `alwaysReady: []` scales to zero; one always-ready instance is
      // the knob if cold start is too slow.
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
      // WHOLE-COLLECTION PUT: a live setting absent here is DELETED next deploy. No FUNCTIONS_* or
      // WEBSITE_NODE_DEFAULT_VERSION/RUN_FROM_PACKAGE: Flex rejects them.
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
        // Both resolve through the UAMI (keyVaultReferenceIdentity) over the vault private endpoint,
        // the same way ADMIN_API_KEY below does. No value passes through this template.
        {
          name: 'MINIO_ACCESS_KEY'
          value: '@Microsoft.KeyVault(SecretUri=${minioAccessKeySecretUri})'
        }
        {
          name: 'MINIO_SECRET_KEY'
          value: '@Microsoft.KeyVault(SecretUri=${minioSecretKeySecretUri})'
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
          value: '@Microsoft.KeyVault(SecretUri=${doclingApiKeySecretUri})'
        }
        {
          name: 'TRACK_API_BASE'
          value: trackApiBase
        }
        {
          name: 'TRACK_WORKS_SYNC'
          value: trackWorksSync ? 'true' : 'false'
        }
        {
          name: 'WORKS_WRITE'
          value: worksWrite ? 'true' : 'false'
        }
        {
          name: 'WORKS_READ'
          value: worksRead ? 'true' : 'false'
        }
        {
          name: 'ASSESSMENT_PASS'
          value: assessmentPass ? 'true' : 'false'
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
        {
          name: 'NOTIFY_UPDATE_READER_LINKS'
          value: notifyUpdateReaderLinks ? 'true' : 'false'
        }
        {
          name: 'UPDATES_PUBLISH_DATE_FALLBACK'
          value: updatesPublishDateFallback ? 'true' : 'false'
        }
        // The scheduled-Update announce (src/scripts/announce-updates.js). Empty is off.
        {
          name: 'ANNOUNCE_UPDATES_SCHEDULE'
          value: updatesAnnounceSchedule
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
        {
          name: 'SYNC_PROJECTS_SCHEDULE'
          value: syncProjectsSchedule
        }
        // api/index.js registers the bulk worker only when set; the host resolves
        // `%BULK_DOWNLOADS_QUEUE%`. Empty is off (Flex drops it, so the code reads undefined).
        {
          name: 'BULK_DOWNLOADS_QUEUE'
          value: bulkDownloadsQueue
        }
        // Empty SKIPS the chunk re-stamp and flags `parentFieldsPending`; CHUNK_RESTAMP_INLINE
        // (local development only) runs it on the request instead.
        {
          name: 'CHUNK_RESTAMP_QUEUE'
          value: chunkRestampQueue
        }
        // Search definition apply. Same shape: the worker is registered only when the name is set,
        // and without it the apply route answers 503 and the devbox recipe is the way through.
        {
          name: 'SEARCH_DEFINITIONS_QUEUE'
          value: searchDefinitionsQueue
        }
        // Sync-out to eagle-api. The queue can run with the Eagle consumer off; the flag is the cutover switch.
        {
          name: 'SYNC_OUT_QUEUE'
          value: syncOutQueue
        }
        {
          name: 'SYNC_OUT_EAGLE_ENABLED'
          value: syncOutEagleEnabled ? 'true' : 'false'
        }
        {
          name: 'SYNC_OUT_EAGLE_NATIVE_ENABLED'
          value: syncOutEagleNativeEnabled ? 'true' : 'false'
        }
        {
          name: 'SYNC_OUT_EAGLE_DOCUMENT_ENABLED'
          value: syncOutEagleDocumentEnabled ? 'true' : 'false'
        }
        {
          name: 'SYNC_OUT_EAGLE_ORGANIZATION_ENABLED'
          value: syncOutEagleOrganizationEnabled ? 'true' : 'false'
        }
        {
          name: 'SYNC_OUT_EAGLE_PROJECT_ENABLED'
          value: syncOutEagleProjectEnabled ? 'true' : 'false'
        }
        {
          name: 'SYNC_OUT_EAGLE_UPDATE_ENABLED'
          value: syncOutEagleUpdateEnabled ? 'true' : 'false'
        }
        {
          name: 'SYNC_OUT_EAGLE_NOTIFICATION_ENABLED'
          value: syncOutEagleNotificationEnabled ? 'true' : 'false'
        }
        {
          name: 'SYNC_OUT_EAGLE_COMMENT_ENABLED'
          value: syncOutEagleCommentEnabled ? 'true' : 'false'
        }
        {
          name: 'EAGLE_PROTECTED_API_BASE'
          value: eagleProtectedApiBase
        }
        {
          name: 'EAGLE_KC_CLIENT_ID'
          value: 'demi-sync-out'
        }
        {
          name: 'EAGLE_KC_CLIENT_SECRET'
          value: empty(syncOutEagleClientSecretUri) ? '' : '@Microsoft.KeyVault(SecretUri=${syncOutEagleClientSecretUri})'
        }
        {
          name: 'EAGLE_ENGAGE_MILESTONE'
          value: eagleEngageMilestone
        }
        {
          name: 'RECONCILE_ENGAGE_SCHEDULE'
          value: reconcileEngageSchedule
        }
        // ENGAGE's public API, read by both reconcile scripts. Empty skips their ENGAGE side.
        {
          name: 'ENGAGE_API_BASE'
          value: engageApiBase
        }
        // For put-search-datasources.js connection strings. The identity is the one Search runs
        // indexers as, which in prod is not this app's (main.bicep passes it).
        {
          name: 'DS_SUB'
          value: subscription().subscriptionId
        }
        {
          name: 'DS_RG'
          value: resourceGroup().name
        }
        {
          name: 'DS_IDENTITY_ID'
          value: dataSourceIdentityId
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
          name: 'BULK_FETCH_AHEAD'
          value: string(bulkFetchAhead)
        }
        {
          name: 'BULK_FETCH_CONCURRENCY'
          value: string(bulkFetchConcurrency)
        }
        {
          name: 'BULK_FETCH_BUFFER_BYTES'
          value: string(bulkFetchBufferBytes)
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
        // Plain URIs, not references: the checker reads the current and -standby values itself, so
        // a rotation is accepted without the settings rewrite a Flex app needs to refetch a reference.
        {
          name: 'APIM_GATEWAY_SECRET_URI'
          value: apimGatewaySecretUri
        }
        {
          name: 'EDGE_SECRET_URI'
          value: edgeSecretUri
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
          name: 'SEARCH_INDEX_ACTIVITIES'
          value: searchIndexActivities
        }
        {
          name: 'SEARCH_INDEX_PROJECT_NOTIFICATIONS'
          value: searchIndexProjectNotifications
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
        // No endpoint drops events after one warning (local and tests). The stream travels with the
        // endpoint: each DCR accepts only its own, so never set the pair from different sides.
        {
          name: 'AUDIT_DCR_ENDPOINT'
          value: analyticsAuditConfigured ? analyticsDcrEndpoint : auditDcrEndpoint
        }
        {
          name: 'AUDIT_DCR_IMMUTABLE_ID'
          value: analyticsAuditConfigured ? analyticsDcrImmutableId : auditDcrImmutableId
        }
        {
          name: 'AUDIT_STREAM_NAME'
          value: analyticsAuditConfigured ? 'Custom-EagleAudit_CL' : 'Custom-DemiAudit_CL'
        }
        // Usage counters, unmoved: DemiEvents_CL and its hourly rollup feed GET /admin/analytics.
        {
          name: 'EVENTS_DCR_ENDPOINT'
          value: auditDcrEndpoint
        }
        {
          name: 'EVENTS_DCR_IMMUTABLE_ID'
          value: auditDcrImmutableId
        }
        // Reading the same data back for the admin panel. The query API keys on the workspace
        // GUID, not the resource id, so this is not auditWorkspaceId above.
        {
          name: 'AUDIT_WORKSPACE_CUSTOMER_ID'
          value: auditWorkspaceCustomerId
        }
        // Second workspace GET /admin/audit unions in, holding the rows written since the repoint.
        {
          name: 'ANALYTICS_WORKSPACE_CUSTOMER_ID'
          value: analyticsWorkspaceCustomerId
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
          name: 'DEMI_EAGLE_MIRROR_PRINCIPALS'
          value: eagleMirrorPrincipals
        }
        {
          name: 'DEMI_PDF_TITLE_WORKER_PRINCIPALS'
          value: pdfTitleWorkerPrincipals
        }
        {
          name: 'DEMI_ENGAGE_PRINCIPALS'
          value: engagePrincipals
        }
        {
          name: 'DEMI_TRACK_PRINCIPALS'
          value: trackPrincipals
        }
        {
          // Always present: an empty value makes the gate answer backup-unconfigured and refuse every lease.
          name: 'BACKUP_ACCOUNT'
          value: backupAccountName
        }
        {
          name: 'BACKUP_CONTAINER'
          value: backupContainerName
        }
        {
          name: 'INTAKE_STORAGE_ACCOUNT'
          value: intakeStorageAccount
        }
        {
          name: 'INTAKE_INCOMING_CONTAINER'
          value: intakeIncomingContainer
        }
        {
          name: 'INTAKE_QUARANTINE_CONTAINER'
          value: intakeQuarantineContainer
        }
        {
          name: 'INTAKE_QUARANTINE_CLIENT_ID'
          value: intakeIdentityClientId
        }
        {
          name: 'INTAKE_CAP_GB_PER_MONTH'
          value: empty(intakeStorageAccount) ? '' : string(intakeCapGBPerMonth)
        }
        {
          name: 'INTAKE_SWEEP_SCHEDULE'
          value: empty(intakeStorageAccount) ? '' : '0 */5 * * * *'
        }
        {
          name: 'INTAKE_PENDING_TIMEOUT_HOURS'
          value: empty(intakeStorageAccount) ? '' : '6'
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
        // Inert on Flex, which routes all outbound through the subnet anyway. Kept: if that is
        // wrong, every private endpoint resolves public and is refused.
        {
          name: 'WEBSITE_VNET_ROUTE_ALL'
          value: '1'
        }
        // The landing zone's hub resolver, not 168.63.129.16: privatelink zones are reachable only
        // through it, else Cosmos and Search resolve PUBLIC and every call is rejected.
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
        // Proves a request came through our Front Door, so X-Azure-SocketIP can be trusted. Empty
        // is off; a reference because a plain value would land in ARM history.
        {
          name: 'EDGE_SECRET'
          value: empty(edgeSecretUri) ? '' : '@Microsoft.KeyVault(SecretUri=${edgeSecretUri})'
        }
        {
          name: 'EDGE_GATE'
          value: edgeGate
        }
        // Always set, so the edgeBan timer is registered and an off tick can clear the rule.
        {
          name: 'EDGE_BAN_MODE'
          value: edgeBanMode
        }
        {
          name: 'EDGE_BAN_SCHEDULE'
          value: edgeBanSchedule
        }
        {
          name: 'EDGE_BAN_POLICY'
          value: empty(edgeBanPolicySecretUri) ? '' : '@Microsoft.KeyVault(SecretUri=${edgeBanPolicySecretUri})'
        }
        {
          name: 'EDGE_LOG_WORKSPACE_ID'
          value: edgeLogWorkspaceId
        }
        {
          name: 'EDGE_BAN_RULE_ID'
          value: edgeBanRuleId
        }
        // Public site access curtain (src/controllers/gate.js). Empty answers 404, not 401, so an
        // ungated environment does not advertise a curtain.
        {
          name: 'ACCESS_GATE_PASSWORD'
          value: empty(accessGateSecretUri) ? '' : '@Microsoft.KeyVault(SecretUri=${accessGateSecretUri})'
        }
      ]
      // Platform CORS answers the preflight before the app, so CORS_ORIGIN alone is not enough.
      // portal.azure.com keeps the portal test console working.
      cors: {
        allowedOrigins: concat(
          [ 'https://portal.azure.com' ],
          map(frontendHostNames, h => 'https://${h}')
        )
      }
    }
  }
}

// SCM is internet-reachable and answers 401, so basic auth on is an unthrottled guessing surface.
// Nothing uses it: CI publishes with OIDC and `config-zip`.
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

// SCM deploys bypass the app's audit trail. Sent to the AUDIT workspace because demi-logs stops
// collecting at its dailyQuotaGb.
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
