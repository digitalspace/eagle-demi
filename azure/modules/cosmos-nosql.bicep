// Azure Cosmos DB for NoSQL — DEMI's target data store.
//
// Replaces the MongoDB-API account in azure/modules/cosmos-db.bicep. An account's API is
// fixed at creation, so this is a new account plus a re-seed, not an in-place conversion.
// Both accounts exist during the migration; the Mongo one is deleted in the final phase.
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
    capabilities: [
      {
        name: 'EnableServerless'
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

// Independently ACL'd slices of a project (e.g. NRPTI aggregates). Making the fragment its
// own item means the existing readClause applies unchanged — a caller who may not see the
// fragment never fetches it, rather than fetching then stripping.
resource projectFragmentsContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'project_fragments'
  properties: {
    resource: {
      id: 'project_fragments'
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
            path: '/fragmentType/?'
          }
          {
            path: '/read/[]/?'
          }
        ]
        excludedPaths: noIndex
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

// NRPTI compliance records. 0 of 4,045 are unlinked, so /projectId is safe (no hot
// empty-string partition). Referencing these instead of folding them into projects is what
// removes the ~250-record 2 MB ceiling. /sourceData is deliberately unindexed.
resource recordsContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'records'
  properties: {
    resource: {
      id: 'records'
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
            // `dataset` is the DEMI field (seed/transform.js writes it from NRPTI's
            // `_schemaName`). `nrptiSchemaName` is only the TYPESENSE index field name — indexing
            // it here would index a property no item has, while the field the repository actually
            // filters on stayed unindexed and scanned.
            path: '/dataset/?'
          }
          {
            path: '/issuingAgency/?'
          }
          {
            path: '/dateIssued/?'
          }
          {
            path: '/recordName/?'
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
        ]
        excludedPaths: noIndex
      }
    }
  }
}

// Extracted document text, full-text INDEXED — the container Deep Search reads.
//
// Separate from `chunks` because a full-text policy and a vector policy are both IMMUTABLE:
// they can only be set when the container is created, so enabling search on `chunks` in place is
// not possible. `chunks` stays until its rows have been copied here (MIGRATION.md §F stage 4).
//
// NO vector policy, though one was intended here — a container vector policy requires the
// account capability `EnableNoSQLVectorSearch`, and `demi-cosmos-dev` carries only
// `EnableServerless`. Deploying it fails the whole container with
// "A Container Vector Policy has been provided, but the capability has not been enabled".
// Base full-text search needs no capability at all; only vector does. Enabling it is an
// account-level, effectively one-way change and a decision for whoever owns the AI boundary —
// today retrieval is lexical BM25 and AI is a summariser over the final top-N, not a retriever.
// The cost of leaving it out is real but deferred: vector policies are IMMUTABLE, so adding
// embeddings later means a third container and another full copy of the chunk corpus.
//
// This resource pins a newer API version than the rest of the file: `fullTextPolicy` and
// `indexingPolicy.fullTextIndexes` do not exist before 2025-10-15, and bicep reports them as
// BCP037 warnings rather than errors — i.e. they would be silently dropped from the deployment
// and the container would come out unsearchable with no failure anywhere.
resource chunksFtsContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2025-10-15' = {
  parent: database
  name: 'chunks_fts'
  properties: {
    resource: {
      id: 'chunks_fts'
      // Unchanged from `chunks`, so replaceForDocument stays a single-partition operation.
      partitionKey: {
        paths: [
          '/documentId'
        ]
        kind: 'Hash'
      }
      fullTextPolicy: {
        defaultLanguage: 'en-US'
        fullTextPaths: [
          {
            path: '/content'
            language: 'en-US'
          }
        ]
      }
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [
          {
            path: '/documentId/?'
          }
          {
            // Project scope rides this, NOT the partition key — see src/repositories/chunks.js.
            path: '/projectId/?'
          }
          {
            path: '/read/[]/?'
          }
        ]
        // /content is excluded from the RANGE index and indexed only for full text. A range index
        // over 2,951-character values would be write amplification for a path nothing sorts or
        // compares on.
        excludedPaths: noIndex
        fullTextIndexes: [
          {
            path: '/content'
          }
        ]
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

// TTL bounds the collection permanently. Note TTL requires indexing to stay active, so the
// narrow include list below is deliberate — indexingMode 'none' would disable expiry.
resource logsContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'logs'
  properties: {
    resource: {
      id: 'logs'
      partitionKey: {
        paths: [
          '/id'
        ]
        kind: 'Hash'
      }
      defaultTtl: 1209600 // 14 days
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [
          {
            path: '/level/?'
          }
          {
            path: '/timestamp/?'
          }
          {
            path: '/requestId/?'
          }
        ]
        excludedPaths: noIndex
        compositeIndexes: [
          [
            {
              path: '/level'
              order: 'ascending'
            }
            {
              path: '/timestamp'
              order: 'descending'
            }
          ]
        ]
      }
    }
  }
}

// The nightly sync re-upserts every fire still in the DataBC feed, refreshing _ts. Anything
// that drops out of the feed expires itself — that deletes the stale-fire purge problem
// rather than solving it. Spatial index supports ST_DISTANCE proximity search.
resource wildfiresContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
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

resource syncStateContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'syncState'
  properties: {
    resource: {
      id: 'syncState'
      partitionKey: {
        paths: [
          '/id'
        ]
        kind: 'Hash'
      }
    }
  }
}

// Required by the change-feed processor / Functions trigger. Must be partitioned on /id.
// Created now so enabling real-time Typesense sync later needs no infrastructure change.
resource leasesContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'leases'
  properties: {
    resource: {
      id: 'leases'
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

// No connection-string output. The previous module emitted one through a @secure() output,
// which pushed a live credential across a module boundary. Local auth is disabled here, so
// the endpoint plus the managed identity is all the app needs.
output cosmosAccountId string = cosmosAccount.id
output cosmosAccountName string = cosmosAccount.name
output cosmosEndpoint string = cosmosAccount.properties.documentEndpoint
output databaseName string = database.name
output privateDnsZoneName string = privateDnsZoneName
