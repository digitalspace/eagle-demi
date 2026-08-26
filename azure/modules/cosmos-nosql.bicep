// Azure Cosmos DB for NoSQL — DEMI's target data store.
//
// Replaced the MongoDB-API account, whose template (azure/modules/cosmos-db.bicep) was deleted at
// Phase 8. An account's API is fixed at creation, so this was a new account plus a re-seed, not an
// in-place conversion. The Mongo account itself is deleted after the clean week ends 2026-08-08.
//
// Cost note: serverless bills per request plus storage (~76 MB of data), so an idle account
// is effectively free. The private endpoint is the one flat recurring charge, which is why
// this template is deployed only when the seed and cutover are ready to run.

@description('Location for Cosmos DB Account')
param location string = resourceGroup().location

@description('Environment name (e.g. dev, test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

@description('Subnet ID for the private endpoint. When empty, public network access stays enabled (local development only).')
param peSubnetId string = ''

@description('Principal ID of the user-assigned managed identity that the API runs as')
param apiPrincipalId string

@description('Optional Entra group/user object ID granted read-only data access, so humans can use Data Explorer once local auth is disabled')
param readerPrincipalId string = ''

@description('Resource id of the demi-audit-<env> workspace. Empty skips control-plane auditing rather than failing the deployment.')
param auditWorkspaceId string = ''

// The wildfires container exists only to serve `sources.wildfires` enrichment. Prod publishes none
// (ENRICHMENT_SOURCES empty), so declaring it there would create a container nothing reads or writes.
//
// `boundaries` is deliberately NOT gated on this. It is reference data, not enrichment output:
// `GET /boundaries` and `GET /db/stats` query it unconditionally in every environment, and an empty
// container answers those with `[]` and `0`. A missing one answers both with a Cosmos 404 → HTTP 500,
// and /db/stats is the deploy-verification endpoint.
@description('Declare the Cosmos wildfires container. False leaves the environment without `sources.wildfires`.')
param deployEnrichment bool = true

var accountName = 'demi-cosmos-${environmentName}'
var databaseName = 'demi'
var privateEndpointName = 'pe-cosmos-nosql-${environmentName}'
var privateDnsZoneName = 'privatelink.documents.azure.com'

// Built-in data-plane role definitions. These GUIDs are fixed across every Cosmos account.
var dataContributorRoleId = '00000000-0000-0000-0000-000000000002'
var dataReaderRoleId = '00000000-0000-0000-0000-000000000001'

// Only the paths actually filtered, sorted or joined on are indexed. Cosmos indexes every
// path by default, which on this data would mean indexing raw upstream payloads
// (sources.*, sourceData), boundary geometry and chunk content — pure write amplification.
// /read/[]/? is security-critical: without it every ACL-filtered read is a full scan.
var noIndex = [
  {
    path: '/*'
  }
  {
    path: '/_etag/?'
  }
]

resource cosmosAccount 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' = {
  name: accountName
  location: location
  tags: tags
  kind: 'GlobalDocumentDB'
  identity: {
    type: 'None'
  }
  properties: {
    databaseAccountOfferType: 'Standard'
    publicNetworkAccess: !empty(peSubnetId) ? 'Disabled' : 'Enabled'
    // No account keys. The API authenticates with its managed identity via Entra, so there
    // is no connection string to leak — this repository is public.
    disableLocalAuth: true
    disableKeyBasedMetadataWriteAccess: true
    minimalTlsVersion: 'Tls12'
    // All three are on the live account. The two preview enrolments are VESTIGIAL: Cosmos native
    // full-text search was ruled out (fuzzy `distance` is a silent no-op even with the preview
    // enrolled, MIGRATION.md §F) and nothing generates embeddings, so neither is used by any query.
    // They are declared anyway because a deployment that omitted them would strip capabilities off
    // a live account as a side effect of describing it — removing them is a decision, not a
    // consequence of writing this file down.
    capabilities: [
      {
        name: 'EnableServerless'
      }
      {
        name: 'EnableNoSQLFullTextSearchPreviewFeatures'
      }
      {
        name: 'EnableNoSQLVectorSearch'
      }
    ]
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]

    // On, matching the live account. It does nothing on a single-region account — there is nowhere
    // to fail over TO — but the ARM default is false, so omitting it would silently turn a flag off
    // as a side effect of writing this file down. It becomes meaningful only if a second region is
    // ever added, which is a cost decision nobody has made.
    enableAutomaticFailover: true
  }
}

resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-11-15' = {
  parent: cosmosAccount
  name: databaseName
  properties: {
    resource: {
      id: databaseName
    }
  }
}

// ── Containers ───────────────────────────────────────────────────────────────
// Partition keys are chosen from the real access patterns and are irreversible once data
// lands. Project-scoped authorization rides these keys rather than the read[] ACL, so a
// scoped caller becomes a partition filter instead of a cross-partition scan.

// ~392 items. Every query is either a point read or a full list; there is no grouping
// dimension any query filters on, so /id gives perfect distribution and 1 RU point reads.
resource projectsContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'projects'
  properties: {
    resource: {
      id: 'projects'
      partitionKey: {
        paths: [
          '/id'
        ]
        kind: 'Hash'
      }
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [
          {
            path: '/name/?'
          }
          {
            path: '/read/[]/?'
          }
          {
            path: '/isPublished/?'
          }
          {
            path: '/sourceSystem/?'
          }
          {
            path: '/trackProjectId/?'
          }
          {
            path: '/eagleId/?'
          }
          {
            path: '/regionalDistrict/?'
          }
          {
            path: '/municipality/?'
          }
          {
            path: '/electoralDistrict/?'
          }
          {
            path: '/updatedAt/?'
          }
        ]
        excludedPaths: noIndex
        compositeIndexes: [
          [
            {
              path: '/isPublished'
              order: 'ascending'
            }
            {
              path: '/name'
              order: 'ascending'
            }
          ]
        ]
      }
    }
  }
}

// ~60k from Eagle. GET /documents?project=X is the dominant list, so /projectId makes it a
// single-partition query. By-id reads become a cross-partition point lookup: +2-3 RU, not a scan.
resource documentsContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'documents'
  properties: {
    resource: {
      id: 'documents'
      partitionKey: {
        paths: [
          '/projectId'
        ]
        kind: 'Hash'
      }
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [
          {
            path: '/projectId/?'
          }
          {
            path: '/read/[]/?'
          }
          {
            path: '/isPublished/?'
          }
          {
            path: '/contentExtracted/?'
          }
          // No '/id/?' here, and it cannot go here: Cosmos rejects the whole policy with "the
          // specified path '/id/?' could not be accepted because it overrides system property
          // 'id'". `id` is always indexed and cannot be included or excluded, so the by-id
          // cross-partition fallback documents.getById uses when no ?project is supplied — the
          // frontend's path on every document open — is already served.
          {
            path: '/fileExt/?'
          }
          {
            path: '/displayName/?'
          }
          {
            path: '/sourceSystem/?'
          }
          {
            path: '/updatedAt/?'
          }
        ]
        excludedPaths: noIndex
      }
    }
  }
}

// Extracted document text. replaceChunks deletes then reinserts every chunk for a document,
// which /documentId confines to a single logical partition. /content stays unindexed.
resource chunksContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'chunks'
  properties: {
    resource: {
      id: 'chunks'
      partitionKey: {
        paths: [
          '/documentId'
        ]
        kind: 'Hash'
      }
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [
          {
            path: '/documentId/?'
          }
          {
            path: '/projectId/?'
          }
          {
            path: '/read/[]/?'
          }
          // The fallback arm of readClause filters on isPublished, so every non-privileged chunk
          // read carried an unindexed term without this.
          {
            path: '/isPublished/?'
          }
        ]
        excludedPaths: noIndex
      }
    }
  }
}

// 244 reference items. /type is only three values — normally an anti-pattern, correct here:
// the sole list query filters on it, and the whole container is a few MB once raw geometry
// is dropped (full-resolution GeoJSON is a build artifact served as a static asset).
resource boundariesContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'boundaries'
  properties: {
    resource: {
      id: 'boundaries'
      partitionKey: {
        paths: [
          '/type'
        ]
        kind: 'Hash'
      }
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [
          {
            path: '/type/?'
          }
          {
            path: '/name/?'
          }
          {
            path: '/code/?'
          }
          // The read predicate. Boundaries are ACL-gated like every other container now, and an
          // unindexed ACL term would scan on every anonymous map load.
          {
            path: '/read/[]/?'
          }
          {
            path: '/isPublished/?'
          }
          // No '/id/?' — see the documents container above. The by-id cross-partition fallback
          // getById uses when no ?type is supplied is already served by the system index.
        ]
        excludedPaths: [
          {
            path: '/*'
          }
          {
            path: '/geometry/*'
          }
          {
            path: '/_etag/?'
          }
        ]
      }
    }
  }
}

// The sync (manual: POST /admin/sync/wildfires) re-upserts every fire still in the DataBC
// feed, refreshing _ts. Anything
// that drops out of the feed expires itself — that deletes the stale-fire purge problem
// rather than solving it. Spatial index supports ST_DISTANCE proximity search.
resource wildfiresContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = if (deployEnrichment) {
  parent: database
  name: 'wildfires'
  properties: {
    resource: {
      id: 'wildfires'
      partitionKey: {
        paths: [
          '/id'
        ]
        kind: 'Hash'
      }
      defaultTtl: 604800 // 7 days
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [
          {
            path: '/fireStatus/?'
          }
          {
            path: '/isFireOfNote/?'
          }
          {
            path: '/fireYear/?'
          }
        ]
        excludedPaths: [
          {
            path: '/*'
          }
          {
            path: '/perimeterGeoJson/*'
          }
          {
            path: '/_etag/?'
          }
        ]
        spatialIndexes: [
          {
            path: '/location/*'
            types: [
              'Point'
            ]
          }
        ]
      }
    }
  }
}

// No syncState container. It was defined here and nothing ever read or wrote it — there is no
// sync cursor to persist, because the AI Search indexers hold their own high-water mark on _ts.
// The container still exists in the live account; this template is not deployed, so removing the
// definition deletes nothing. Delete it with the account teardown if it is still empty.

// Registry API keys, one item per consumer. Partitioned on /id, where the id IS the public keyId
// carried in the key itself — that makes verification a point read in a single partition on the
// hot path of every X-Api-Key request, instead of a scan comparing every stored hash.
//
// /hash is deliberately NOT indexed: nothing queries by it (verification is a point read plus a
// constant-time compare in helpers/api-key.js), and an index is one more copy of a secret digest.
// No TTL — expiry is a field checked at verify time, because a key must remain visible in the
// admin listing after it expires or is revoked, or the audit trail vanishes with it.
resource apiKeysContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'apikeys'
  properties: {
    resource: {
      id: 'apikeys'
      partitionKey: {
        paths: [
          '/id'
        ]
        kind: 'Hash'
      }
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [
          {
            // The admin listing orders by this; everything else is a point read.
            path: '/createdAt/?'
          }
        ]
        excludedPaths: [
          {
            path: '/*'
          }
          {
            path: '/hash/?'
          }
          {
            path: '/_etag/?'
          }
        ]
      }
    }
  }
}

// Runtime configuration for the frontend, one item with id 'config'. Partitioned on /id so the
// read GET /api/config performs is a point read in a single partition — ~1 RU, and serverless
// bills consumption, so an idle container costs nothing.
//
// Its own container rather than a row in `apikeys`, whose indexing policy exists to keep /hash out
// of the index — not the right neighbour for a document served to the public verbatim.
//
// No indexing policy: one item, read by id, never queried.
resource configContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'config'
  properties: {
    resource: {
      id: 'config'
      partitionKey: {
        paths: [
          '/id'
        ]
        kind: 'Hash'
      }
    }
  }
}

// ── Data-plane RBAC ──────────────────────────────────────────────────────────
// Cosmos NoSQL data-plane role assignments cannot be managed in the Azure portal, so they
// have to live here. Built-in definitions are used rather than a custom role — a custom
// definition with one consumer would be an abstraction with a single implementation.

resource apiDataContributor 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: cosmosAccount
  name: guid(cosmosAccount.id, apiPrincipalId, dataContributorRoleId)
  properties: {
    roleDefinitionId: '${cosmosAccount.id}/sqlRoleDefinitions/${dataContributorRoleId}'
    principalId: apiPrincipalId
    scope: cosmosAccount.id
  }
}

// Without this, Data Explorer is empty for every human once disableLocalAuth is set.
resource humanDataReader 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = if (!empty(readerPrincipalId)) {
  parent: cosmosAccount
  name: guid(cosmosAccount.id, readerPrincipalId, dataReaderRoleId)
  properties: {
    roleDefinitionId: '${cosmosAccount.id}/sqlRoleDefinitions/${dataReaderRoleId}'
    principalId: readerPrincipalId
    scope: cosmosAccount.id
  }
}

// ── Private networking ───────────────────────────────────────────────────────
// groupIds is 'Sql' for the NoSQL API — 'MongoDB' (used by the old account) silently
// produces an endpoint that never resolves. The DNS zone differs too:
// privatelink.documents.azure.com rather than privatelink.mongo.cosmos.azure.com.

resource privateEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = if (!empty(peSubnetId)) {
  name: privateEndpointName
  location: location
  tags: tags
  properties: {
    subnet: {
      id: peSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: privateEndpointName
        properties: {
          privateLinkServiceId: cosmosAccount.id
          groupIds: [
            'Sql'
          ]
        }
      }
    ]
  }
}

// Who changed the database itself — containers, throughput, firewall, RBAC. The app's audit trail
// covers authenticated writes to the DATA; this covers authenticated changes to the store holding
// it, which the app cannot see and the landing-zone policy ships only to a central workspace we
// cannot read.
resource cosmosAuditDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(auditWorkspaceId)) {
  scope: cosmosAccount
  // Distinct from the landing zone's `setByPolicy-LogAnalytics` on this same account — a shared
  // name would make the two fight on every deploy.
  name: 'demi-audit'
  properties: {
    workspaceId: auditWorkspaceId
    // Without Dedicated these land in the shared AzureDiagnostics column soup and
    // CDBControlPlaneRequests never appears as a table at all.
    logAnalyticsDestinationType: 'Dedicated'
    // ControlPlaneRequests ONLY. DataPlaneRequests is one row per Cosmos operation — a single
    // corpus re-extraction is ~1.13M chunk writes — and it duplicates what the app already logs.
    // Turn that on for the length of an incident, never as a standing setting.
    logs: [
      {
        category: 'ControlPlaneRequests'
        enabled: true
      }
    ]
  }
}

// No connection-string output. The previous module emitted one through a @secure() output,
// which pushed a live credential across a module boundary. Local auth is disabled here, so
// the endpoint plus the managed identity is all the app needs.
output cosmosAccountId string = cosmosAccount.id
output cosmosAccountName string = cosmosAccount.name
output cosmosEndpoint string = cosmosAccount.properties.documentEndpoint
output databaseName string = database.name
output privateDnsZoneName string = privateDnsZoneName
