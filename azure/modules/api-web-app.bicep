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

// All three index names are PINNED TO THE OLD `demi-` NAMES on purpose, even though the committed
// definitions under `azure/search/` now carry the plain names. The physical indexes on
// `demi-search-test` are still `demi-chunks`/`demi-projects`/`demi-documents`, and they keep
// serving every query until these three lines change. Deploying this template must therefore change
// nothing live.
//
// FLIPPING ALL THREE OF THESE DEFAULTS TO `chunks`/`projects`/`documents` **IS** THE CUTOVER.
// There is no other switch, no code release and no data-plane step left in it — that is the whole
// reason `searchIndexProjects` and `searchIndexDocuments` exist at all; until they were added only
// the chunk index had an app setting, so the other two could only be moved by a code change.
//
// DO NOT FLIP THEM YET. As of 2026-08-22 the plain-named indexes EXIST but are still filling. Do
// not trust a percentage written here — read the counts, because a stale figure in a comment is
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
param searchIndex string = 'demi-chunks'

@description('Azure AI Search index holding project metadata. Pinned to the live name; see the cutover note above.')
param searchIndexProjects string = 'demi-projects'

@description('Azure AI Search index holding document metadata. Pinned to the live name; see the cutover note above.')
param searchIndexDocuments string = 'demi-documents'

@description('Foundry account endpoint for the AI summariser. Empty leaves the summary panel off rather than failing search.')
param foundryEndpoint string = ''

@description('Foundry model deployment name for the AI summariser')
param foundryDeployment string = ''

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

@description('Requests per minute per rate-limit bucket. 300 suits direct browser traffic, where one caller is one bucket; behind a reverse proxy every visitor shares a single bucket and this must be raised.')
param rateLimitMaxRequests int = 300

@description('MinIO bucket holding the document corpus')
param minioBucketName string = 'eagle-demi'

@description('Key prefix within that bucket')
param minioKeyPrefix string = ''

@description('Break-glass sysadmin credential, INBOUND. This is what the extraction host presents as X-Api-Key when posting chunks, and the only credential the admin endpoints accept while the key registry is empty.')
@secure()
param adminApiKey string = ''

@description('OUTBOUND credential DEMI presents to docling-serve as X-Api-Key. Nothing inbound validates it. Not the extraction host\'s credential — that is adminApiKey.')
@secure()
param doclingApiKey string = ''

@description('Keycloak base URL for this environment (dev/test/prod loginproxy)')
param keycloakUrl string = environmentName == 'prod'
  ? 'https://loginproxy.gov.bc.ca/auth'
  : (environmentName == 'test' ? 'https://test.loginproxy.gov.bc.ca/auth' : 'https://dev.loginproxy.gov.bc.ca/auth')

@description('Keycloak realm')
param keycloakRealm string = 'eao-epic'

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
resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
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
    serverFarmId: appServicePlan.id
    virtualNetworkSubnetId: !empty(apiSubnetId) ? apiSubnetId : null
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
          value: 'https://demi-api-${environmentName}.azurewebsites.net'
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
        // Requests per minute per rate-limit bucket. Declared here BECAUSE this array is a
        // whole-collection PUT: without a line here the setting has no home, so a hand-set value is
        // deleted by the next infra deploy and the app silently reverts to its built-in default.
        //
        // 300 is right while the browser reaches this app directly, where one caller is one bucket.
        // It is wrong behind a reverse proxy: eao-nginx sets no X-Forwarded-For, App Service appends
        // the proxy's own address, and src/middleware/rate-limiter.js keys on the last entry — so
        // every visitor through eao-nginx's `location = /demi-search/search` shares ONE bucket, and
        // 300/min is 5 r/s for the whole site. Raise this in the same change that routes public
        // traffic through that proxy, not after.
        {
          name: 'RATE_LIMIT_MAX_REQUESTS'
          value: string(rateLimitMaxRequests)
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
        // Credentials for the write paths. Supplied per-environment from the live app settings and
        // never committed — a template carrying real values would put them in deployment history.
        // ADMIN_API_KEY -- not DOCLING_API_KEY -- is what the admin endpoints check.
        {
          name: 'ADMIN_API_KEY'
          value: adminApiKey
        }
        {
          name: 'DOCLING_API_KEY'
          value: doclingApiKey
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
          name: 'KEYCLOAK_ENABLED'
          value: 'true'
        }
        {
          name: 'SSO_ISSUER'
          value: '${keycloakUrl}/realms/${keycloakRealm}'
        }
        {
          name: 'SSO_JWKSURI'
          value: '${keycloakUrl}/realms/${keycloakRealm}/protocol/openid-connect/certs'
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
