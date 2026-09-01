// Azure App Service Module for DEMI Node.js REST API (Serverless Azure Function)
@description('Location for Azure Web App resources')
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

@description('Azure AI Search endpoint, e.g. https://demi-search-dev.search.windows.net. Empty disables chunk search rather than failing it.')
param searchEndpoint string = ''

// All three index names are the PLAIN names, and have been since the cutover on 2026-08-22. The
// committed definitions under `azure/search/`, these defaults, and the live indexes on
// `demi-search-test` all agree. **Deploying this template is what makes them live** — it is not a
// no-op, which is what it was while these lines still said `demi-`.
//
// THESE THREE LINES **ARE** THE SWITCH, in both directions: flipping them back to
// `demi-chunks`/`demi-projects`/`demi-documents` is the entire rollback.
// There is no other switch, no code release and no data-plane step left in it — that is the whole
// reason `searchIndexProjects` and `searchIndexDocuments` exist at all; until they were added only
// the chunk index had an app setting, so the other two could only be moved by a code change.
//
// FLIPPED 2026-08-22, after the gate below was met on both sides. Kept rather than deleted because
// the rollback is flipping these three back, and the reader doing that needs the same reasoning.
// Formerly: DO NOT FLIP THEM YET (superseded — the gate below was met and the flip is done).
// Do not trust a percentage written here — read the counts, because a stale figure in a comment is
// exactly the thing that would talk someone into arming this early. An index name is
// immutable, so the fill is a one-way create-and-refill from Cosmos over the indexers' PT5M
// schedule — there is nothing to wait on but row counts. Arm this only when all three have reached
// their Cosmos source-of-truth totals — COMPARED LIVE, not against numbers transcribed here. The
// Track sync keeps appending, so a written total decays exactly the way a percentage would: once
// Cosmos holds 400 projects an index sitting at the 393 someone wrote down satisfies the gate with
// seven rows missing, which is the very outcome the next paragraph calls dangerous. Read both sides
// and require equality:
//
//     az monitor metrics list --resource <demi-cosmos-*> --metric DocumentCount \\
//       --interval PT5M --aggregation Maximum --filter "CollectionName eq '*'"
//     GET {search-endpoint}/indexes/{projects,documents,chunks}/docs/$count   # from inside the VNet
//
// For the record, both sides read 393 / 60,578 / 1,128,733 on 2026-08-22, which is when the three
// indexes finished filling. That is a log line, not the gate.
//
// Short of that the flip is not a slower search, it is a SILENTLY SMALLER CORPUS answering 200:
// a partly-filled index returns fewer hits under a smaller total, which reads exactly like a query
// that legitimately matched less. Nothing in the app can tell the two apart, which is why the gate
// is a count read off the service rather than a judgement about how long the fill has had.
//
// Counting means reaching the data plane, which is `publicNetworkAccess: Disabled` — from inside
// the app container over the App Service SSH tunnel, per the root `README.md` recipe. The same
// place `azure/search/README.md` step 2 is run from, and that file stays the reference for the
// staged rename; do not restate it here.
//
// ROLLBACK IS FLIPPING THESE THREE BACK. The `demi-` indexes are not deleted, not paused and not
// drained by the cutover — their indexers keep running on PT5M throughout, so they stay current and
// a revert is a settings write, not a refill. Keep them until the plain-named ones have served
// production traffic long enough to trust; deleting them turns a one-setting rollback back into a
// multi-hour reindex of a corpus that only exists in Cosmos.
@description('Azure AI Search index holding document chunks. Pinned to the live name; see the cutover note above.')
param searchIndex string = 'chunks'

@description('Azure AI Search index holding project metadata. Pinned to the live name; see the cutover note above.')
param searchIndexProjects string = 'projects'

@description('Azure AI Search index holding document metadata. Pinned to the live name; see the cutover note above.')
param searchIndexDocuments string = 'documents'

@description('Foundry account endpoint for the AI summariser. Empty leaves the summary panel off rather than failing search.')
param foundryEndpoint string = ''

@description('Foundry model deployment name for the AI summariser')
param foundryDeployment string = ''

@description('Comma-separated `sources` keys a project may publish over HTTP. Empty publishes none.')
param enrichmentSources string = ''

@description('Master switch for the AI summariser. Off by default — the endpoint does not exist until the Foundry account is provisioned, and a half-working summariser is worse than an absent one.')
param summaryEnabled bool = false

@description('Subnet ID for Virtual Network Integration')
param apiSubnetId string = ''

@description('Resource ID of the user-assigned managed identity the app runs as')
param identityId string

@description('Client ID of that identity. DefaultAzureCredential cannot pick between several, so AZURE_CLIENT_ID names the one to use.')
param identityClientId string

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

@description('Key Vault URI of the break-glass sysadmin credential, INBOUND. This is what the extraction host presents as X-Api-Key when posting chunks, and the only credential the admin endpoints accept while the key registry is empty. Not the value: the app resolves it through a Key Vault reference.')
param adminApiKeySecretUri string

@description('OUTBOUND credential DEMI presents to docling-serve as X-Api-Key. Nothing inbound validates it. Not the extraction host\'s credential — that is adminApiKey.')
@secure()
param doclingApiKey string = ''

@description('Keycloak base URL for this environment (dev/test/prod loginproxy)')
param keycloakUrl string = environmentName == 'prod'
  ? 'https://loginproxy.gov.bc.ca/auth'
  : (environmentName == 'test' ? 'https://test.loginproxy.gov.bc.ca/auth' : 'https://dev.loginproxy.gov.bc.ca/auth')

@description('Keycloak realm')
param keycloakRealm string = 'eao-epic'

// src/config.js defaults this to 'eagle-admin-console' too, so setting it changes nothing today —
// the point is that prod stops depending on a code default for which client's tokens it accepts.
@description('Keycloak client whose tokens this API accepts.')
param keycloakClientId string = 'eagle-admin-console'

// Empty is permissive, and src/config.js refuses to boot test or prod on it — so an environment
// that forgets this setting fails loudly at startup instead of admitting every client in the realm.
@description('Comma-separated Keycloak client ids (token azp) permitted to call this API.')
param allowedClients string = ''

// Empty, not 'account': the audience Keycloak actually mints is unmeasured, and a wrong value
// rejects every token. Empty means the check is not enforced.
@description('Expected JWT aud claim. Empty disables audience verification.')
param ssoAudience string = ''

@description('Application Insights connection string. Empty disables telemetry, which is the local-development case.')
param appInsightsConnectionString string = ''

@description('Logs Ingestion endpoint of the audit DCR. Empty disables audit and analytics emission — the local-development and test-suite case.')
param auditDcrEndpoint string = ''

@description('Immutable ID of the audit DCR. Both this and the endpoint are required before anything is sent.')
param auditDcrImmutableId string = ''

@description('Resource id of the demi-audit-<env> workspace. Empty skips deploy-access auditing rather than failing the deployment.')
param auditWorkspaceId string = ''

@description('Frontend hostnames (no scheme) allowed to call this API, as browser origins. An ARRAY because a cutover has two: the old App Service and the new Front Door endpoint must both work while the old one is still the rollback target. Empty until the AFD profile in eagle-search is deployed — its hostname carries a deploy-time hash, so it is filled in afterwards and cannot be composed here.')
param frontendHostNames array = []

@description('Upstream eagle-api the seed loader reads. Must match the environment — the code default in src/seed/sources.js is the DEV instance, so a wrong or missing value reads dev data.')
param eagleApiBase string

@description('NCRONTAB schedule for the nightly Eagle reconcile timer, e.g. `0 0 9 * * *` for 09:00 UTC. Empty registers no timer at all, which is the default in every environment that has not opted in.')
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

@description('NCRONTAB schedule for the Track team sync timer, e.g. `0 0 10 * * *`. Empty registers no timer, same switch as reconcileSchedule.')
param syncTeamsSchedule string = ''

// Empty creates the B1 plan below. Set, the app joins a plan that already exists and this template
// creates none — so it must already be a LINUX plan; a Windows one cannot host `functionapp,linux`.
@description('Resource id of an App Service plan to join instead of creating demi-plan-<env>.')
param existingServerFarmId string = ''

var apiAppName = 'demi-api-${environmentName}'
var appServicePlanName = 'demi-plan-${environmentName}'
var storageAccountName = take('demistg${environmentName}${uniqueString(resourceGroup().id)}', 24)

// Storage Account for API logs and Function host persistence
resource apiStorage 'Microsoft.Storage/storageAccounts@2023-01-01' = {
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

// App Service Plan (Consumption Y1 Serverless Plan for auto-scaling & $0 idle cost)
resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = if (empty(existingServerFarmId)) {
  name: appServicePlanName
  location: location
  tags: tags
  // B1, not Y1/Dynamic. Consumption cannot hold a warm worker or integrate with a VNet the way
  // this app needs, and every operational note in the repo — the 224 MB heap ceiling the scripts
  // run under, the warm worker that serves a stale build until the app is stopped and started —
  // describes a B1 instance. The live plan has always been B1; this said Dynamic.
  sku: {
    name: 'B1'
    tier: 'Basic'
  }
  properties: {
    reserved: true // Linux worker
  }
}

// Azure Function App (Node.js 22 Express API via @azure/functions in Serverless Consumption mode)
resource apiWebApp 'Microsoft.Web/sites@2023-12-01' = {
  name: apiAppName
  location: location
  tags: tags
  kind: 'functionapp,linux'
  // USER-assigned, not system-assigned. The identity outlives the app, so a redeploy does not
  // invalidate its Cosmos, Search and Storage role assignments — and it can be granted access
  // BEFORE the app exists, which a system-assigned principal cannot. This block said
  // 'SystemAssigned' while the live app has always run as demi-identity-dev, and the comment on
  // SEARCH_ENDPOINT below already described it correctly.
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    serverFarmId: empty(existingServerFarmId) ? appServicePlan!.id : existingServerFarmId
    virtualNetworkSubnetId: !empty(apiSubnetId) ? apiSubnetId : null
    // Key Vault references resolve as the SYSTEM-assigned identity unless told otherwise, and this
    // app has none — the secrets-read grant is on the user-assigned identity, so without this line
    // ADMIN_API_KEY stays an unresolved literal and every admin call 401s.
    keyVaultReferenceIdentity: identityId
    siteConfig: {
      linuxFxVersion: 'NODE|22'
      vnetRouteAllEnabled: !empty(apiSubnetId)
      // No bicep property set this before, so the live value was the ARM default `false` — and
      // `false` on a DEDICATED plan is the one case where it bites. demi-plan-test is B1, tier
      // Basic (verified 2026-08-22), not Consumption: the worker is paid for and running whether
      // or not the host is loaded, so unloading it after ~20 minutes idle buys nothing and costs
      // the next caller a ~50s cold start answered with an EMPTY body. A browser cannot tell that
      // apart from a CORS failure — no Access-Control-Allow-Origin comes back on a response the
      // host never produced — so the symptom lands in the frontend as a CORS error and sends
      // whoever is debugging it to CORS_ORIGIN, which is not wrong.
      alwaysOn: true
      appSettings: [
        // src/controllers/config.js falls back to DEV values for both of these, which was
        // invisible while dev was the only environment — pin them per environment.
        {
          name: 'ENVIRONMENT'
          value: environmentName
        }
        {
          name: 'API_LOCATION'
          // Empty like the Flex module: /api/config must say same-origin even from the rollback app.
          value: ''
        }
        {
          name: 'AzureWebJobsStorage'
          value: 'DefaultEndpointsProtocol=https;AccountName=${apiStorage.name};EndpointSuffix=${environment().suffixes.storage};AccountKey=${apiStorage.listKeys().keys[0].value}'
        }
        {
          name: 'FUNCTIONS_WORKER_RUNTIME'
          value: 'node'
        }
        {
          name: 'FUNCTIONS_EXTENSION_VERSION'
          value: '~4'
        }
        {
          name: 'WEBSITE_NODE_DEFAULT_VERSION'
          value: '~22'
        }
        {
          name: 'WEBSITE_RUN_FROM_PACKAGE'
          value: '1'
        }
        // Azure Monitor. The Functions host reads this to emit request, dependency and exception
        // telemetry with no code involved; `api/index.js` reads the same variable to decide whether
        // to start the OpenTelemetry distro that carries the winston lines.
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: appInsightsConnectionString
        }
        // The distro in application code owns instrumentation. Leaving the platform agent on as
        // well means two SDKs instrumenting the same process, which double-counts telemetry.
        {
          name: 'APPLICATIONINSIGHTS_ENABLE_AGENT'
          value: 'false'
        }
        // The identity above, named. DefaultAzureCredential has no way to choose between several
        // user-assigned identities on one app, so without this it fails to authenticate at all.
        {
          name: 'AZURE_CLIENT_ID'
          value: identityClientId
        }
        // Cosmos DB for NoSQL. Keyless, so there is no connection string — just where it is and
        // which database.
        //
        // No COSMOS_DATABASE. This template used to set it too, with a comment claiming it was
        // "still read as a fallback" — it is not: `src/db/cosmos-nosql.js:38` reads
        // COSMOS_NOSQL_DATABASE and nothing else, and no other file reads COSMOS_DATABASE at all.
        // On dev it held `epic`, the Mongo-era database name, so the one thing it did was make the
        // deployed configuration look like it still pointed at a database that no longer exists.
        // Removed from dev 2026-08-07 and from here, so the template keeps describing dev.
        {
          name: 'COSMOS_ENDPOINT'
          value: cosmosEndpoint
        }
        {
          name: 'COSMOS_NOSQL_DATABASE'
          value: cosmosDatabase
        }
        // No Cosmos DB for MongoDB API settings. COSMOSDB_URI, COSMOSDB_DATABASE, MONGODB_URI and
        // MONGODB_DATABASE all carried the same connection string and the same 'epic' database, and
        // all four went with the Mongo data layer at Phase 8. The NoSQL account is keyless, so its
        // settings are COSMOS_ENDPOINT plus COSMOS_NOSQL_DATABASE and there is no secret to wire.
        // MinIO Storage Connection
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
        // Declared here BECAUSE this array is a whole-collection PUT: a setting that exists live and
        // is absent here is deleted by the next infra deploy. Per environment — test must hand back
        // the test host, not prod's.
        {
          name: 'LINK_BASE_URL'
          value: linkBaseUrl
        }
        // Which object store the API reads. Flipping this to 'azure' is the Phase 3b cutover and
        // needs the blob account deployed and the corpus copied first.
        {
          name: 'STORAGE_BACKEND'
          value: storageBackend
        }
        // Upstream eagle-api the seed loader reads. Declared here because this appSettings array is
        // a WHOLE-COLLECTION PUT: a setting that exists live and is absent here is deleted, and
        // src/seed/sources.js:19 then falls back to its hardcoded eagle-DEV URL — so omitting this
        // silently repoints staging's seed at dev data with no error anywhere.
        {
          name: 'EAGLE_API_BASE'
          value: eagleApiBase
        }
        // The nightly drift report's only switch. api/index.js registers the timer only when this
        // is set, and the host resolves the schedule out of it as `%RECONCILE_SCHEDULE%`. Empty is
        // off, and it has to be declared here even when empty for the whole-collection-PUT reason
        // above: a value set by hand on the live app is deleted by the next infra deploy.
        {
          name: 'RECONCILE_SCHEDULE'
          value: reconcileSchedule
        }
        // Credentials for the write paths. Supplied per-environment from the live app settings and
        // never committed — a template carrying real values would put them in deployment history.
        // ADMIN_API_KEY -- not DOCLING_API_KEY -- is what the admin endpoints check.
        //
        // Resolves through the UAMI (keyVaultReferenceIdentity) over the vault private endpoint; see the PE note below.
        {
          name: 'ADMIN_API_KEY'
          value: '@Microsoft.KeyVault(SecretUri=${adminApiKeySecretUri})'
        }
        {
          name: 'DOCLING_API_KEY'
          value: doclingApiKey
        }
        // Track team sync — src/scripts/sync-track-teams.js, registered as a timer only when
        // SYNC_TEAMS_SCHEDULE is set. All six are declared even when empty, for the
        // whole-collection-PUT reason above: a value set by hand on the live app is deleted by the
        // next infra deploy. Both secrets are Key Vault references, like ADMIN_API_KEY.
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
        // Azure AI Search — Deep Search over extracted document text. No key: the service has
        // disableLocalAuth, so the app authenticates with the same user-assigned identity it uses
        // for Cosmos. When SEARCH_ENDPOINT is absent the chunk dataset degrades to empty results
        // and says so once, rather than failing the whole search endpoint.
        {
          name: 'SEARCH_ENDPOINT'
          value: searchEndpoint
        }
        // All three named explicitly. `appSettings` is a WHOLE-COLLECTION PUT: a setting that
        // exists on the live app but is absent from this list is DELETED by the next deploy, so
        // the projects and documents indexes cannot be set once by hand and left out of here.
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
        // AI summariser — step 5 of the search pipeline, privileged-only. No key here either: the
        // Foundry account has disableLocalAuth and the app calls it with the same user-assigned
        // identity. Retrieval is unaffected by all three of these; with SUMMARY_ENABLED false the
        // summary endpoint returns `{summary: null}` and the results columns are untouched.
        {
          name: 'SUMMARY_ENABLED'
          // NOT string(summaryEnabled): ARM stringifies booleans as 'True'/'False', and
          // src/config.js compares === 'true'. Greenfield test shipped 'True' and the
          // summariser silently reported "switched off".
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
        // Audit and usage analytics. No key: the app publishes to the DCR with the same
        // user-assigned identity, holding Monitoring Metrics Publisher and nothing else. Absent
        // endpoint means events are dropped after a single warning rather than throwing — the
        // same "empty disables" shape as SEARCH_ENDPOINT above, and what makes local development
        // and the test suite work with no Azure at all.
        {
          name: 'AUDIT_DCR_ENDPOINT'
          value: auditDcrEndpoint
        }
        {
          name: 'AUDIT_DCR_IMMUTABLE_ID'
          value: auditDcrImmutableId
        }
        // Keycloak / SSO — MUST be pinned per environment. Without these the API falls
        // back to src/config.js defaults, which point at the DEV realm, so a dev-realm
        // token would be accepted as admin in test and prod.
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
        // Browser CORS allowlist — unset previously meant "reflect any origin".
        //
        // The frontend is no longer at a hostname this template can compose: it is a Storage
        // static website behind Front Door, and the AFD endpoint carries a deploy-time hash. Empty
        // leaves CORS_ORIGIN unset, and src/app.js then falls back to localhost only — no browser
        // origin, rather than any browser origin.
        //
        // Comma-separated, which is what src/app.js splits on. An empty array joins to '', which is
        // the fail-closed state described above — not a wildcard.
        {
          name: 'CORS_ORIGIN'
          value: join(map(frontendHostNames, h => 'https://${h}'), ',')
        }
        // Build & Deployment Configuration
        {
          name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
          value: 'false'
        }
        {
          name: 'WEBSITE_HTTPLOGGING_RETENTION_DAYS'
          value: '3'
        }
        // Oryx must not build on deploy: the zip already carries node_modules, and letting the
        // platform rebuild it both slows the deploy and can resolve different versions.
        {
          name: 'ENABLE_ORYX_BUILD'
          value: 'false'
        }
        // Route ALL outbound traffic through the integrated subnet, and resolve DNS through Azure
        // — without both, the private endpoints for Cosmos and Search resolve to public IPs the
        // app cannot reach.
        {
          name: 'WEBSITE_VNET_ROUTE_ALL'
          value: '1'
        }
        // THE LANDING ZONE'S resolver, not Azure's platform default 168.63.129.16. The
        // privatelink zones live in a central subscription reachable only through the hub
        // resolver; with the platform default the app resolves Cosmos/Search to their PUBLIC
        // addresses and every call is rejected at the firewall as "originated from public
        // internet". Live dev always ran 10.53.244.4 out-of-band; the template said
        // 168.63.129.16 and greenfield test proved the template wrong on first contact.
        {
          name: 'WEBSITE_DNS_SERVER'
          value: '10.53.244.4'
        }
        {
          name: 'AzureWebJobsFeatureFlags'
          value: 'EnableWorkerIndexing'
        }
      ]
      // Platform-level CORS, in front of the app's own. portal.azure.com is what makes the
      // built-in test console work; the frontend origin is added only once it is known. The
      // `demi-frontend-swa-*.azurestaticapps.net` entry that used to sit here is gone with the
      // Static Web App idea — Microsoft.Web/staticSites cannot deploy in any region this landing
      // zone's Resource-Locations policy allows.
      //
      // BOTH layers have to name an origin for the browser to reach the API. This one runs first
      // and answers the preflight itself, so adding a host to CORS_ORIGIN alone is not enough.
      cors: {
        allowedOrigins: concat(
          [ 'https://portal.azure.com' ],
          map(frontendHostNames, h => 'https://${h}')
        )
      }
    }
  }
}

// A PUBLIC PASSWORD-GUESSING PATH, closed. `<app>.scm.azurewebsites.net` is internet-reachable and
// answers 401 rather than refusing the connection, so while these policies allow basic auth the
// SCM endpoint is an unthrottled credential-guessing surface onto the box that holds the only
// extracted copy of the corpus — and that serves eagle-public's TEST search.
//
// NOTHING HERE AUTHENTICATES THAT WAY, which is what makes this safe to turn off rather than a
// trade. `scripts/deploy-azure.sh:52` mints an AAD bearer with `az account get-access-token` and
// uses it for both the VFS reads (`:82`) and the zipdeploy (`:139`); CI logs in with OIDC. There
// are no publish profiles and no `deployment list-publishing-credentials` call anywhere in
// `.github/` or `scripts/`.
//
// Both children, though `scm: false` already neuters ftp — declaring only one leaves the other
// reading `allow: true` in the portal, which reads as a half-applied control. `name` is a
// deploy-time constant here: `scm` and `ftp` are the only literals that compile.
//
// Not parameterised. There is no environment where this should be true, and a param would invite
// one. `azure/modules/extractor.bicep` is deliberately NOT covered by this — it sits outside
// `main.bicep`, is Flex Consumption and deploys by hand; its `ftpsState: 'Disabled'` is a
// different control and is not evidence it is covered.
resource apiScmBasicAuth 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: apiWebApp
  name: 'scm'
  properties: {
    allow: false
  }
}

resource apiFtpBasicAuth 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: apiWebApp
  name: 'ftp'
  properties: {
    allow: false
  }
}

// Who authenticated to Kudu/SCM and deployed. Nothing captured this before: the app's own audit
// trail covers authenticated writes through the API, and a deploy is the one authenticated change
// that never passes through it.
//
// Into the AUDIT workspace, not demi-logs: demi-logs stops collecting at its dailyQuotaGb, and a
// record that a busy day can drop is not an audit record.
resource apiAuditDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(auditWorkspaceId)) {
  scope: apiWebApp
  // Distinctly named: the landing zone sets its own `setByPolicy-*` settings on resources here,
  // and a colliding name would have the two overwrite each other on every deploy.
  name: 'demi-audit'
  properties: {
    workspaceId: auditWorkspaceId
    // AppServiceAuditLogs ONLY. AppServiceHTTPLogs is deliberately absent — middleware/http-logger.js
    // already ships method, path, status, duration, IP and `principal` per request to App Insights,
    // and the platform version carries no principal, so it would cost more and say less.
    logs: [
      {
        category: 'AppServiceAuditLogs'
        enabled: true
      }
    ]
  }
}

output apiWebAppName string = apiWebApp.name
output apiWebAppHostName string = apiWebApp.properties.defaultHostName
// The app has no principal of its own any more — it runs as the user-assigned identity, whose
// principal the caller already has from `identity.bicep`.
