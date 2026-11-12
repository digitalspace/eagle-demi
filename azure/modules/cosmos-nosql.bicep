// Serverless bills per request plus storage, so an idle account is nearly free; the private
// endpoint is the one flat recurring charge.

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

// Never gate `boundaries` on this: GET /boundaries and /db/stats read it everywhere, and a missing
// container turns both into a 500.
@description('Declare the Cosmos wildfires container. False leaves the environment without `sources.wildfires`.')
param deployEnrichment bool = true

var accountName = 'demi-cosmos-${environmentName}'
var databaseName = 'demi'
var privateEndpointName = 'pe-cosmos-nosql-${environmentName}'
var privateDnsZoneName = 'privatelink.documents.azure.com'

// Built-in data-plane role definitions. These GUIDs are fixed across every Cosmos account.
var dataContributorRoleId = '00000000-0000-0000-0000-000000000002'
var dataReaderRoleId = '00000000-0000-0000-0000-000000000001'

// Index only paths that are filtered or sorted on; the default indexes raw payloads and content.
// Every container keeps /read/[]/?, else each ACL-filtered read is a full scan.
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
    // Managed identity only: no connection string to leak from a public repo.
    disableLocalAuth: true
    disableKeyBasedMetadataWriteAccess: true
    minimalTlsVersion: 'Tls12'
    // On live in both environments; a template that omits it turns it off on every deploy.
    enablePartitionKeyMonitor: true
    // Both previews are unused but live on the account; dropping them here would strip them on the
    // next deploy, which needs its own decision.
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

    // No effect with one region, but matches the live account; the ARM default would turn it off.
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

// Partition keys cannot change once data lands. Project scoping rides them, so a scoped caller is
// a partition filter, not a cross-partition scan.

// Point reads or full lists only, so /id.
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
            // Scalar leaf of the GeoJSON object: projects.js filters on centroid.type (an object path
            // is never in the inverted index).
            path: '/centroid/type/?'
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
            path: '/eacDecision/_id/?'
          }
          {
            path: '/currentPhaseName/_id/?'
          }
          {
            path: '/CEAAInvolvement/_id/?'
          }
          {
            path: '/phaseIds/[]/?'
          }
          {
            path: '/decisionDate/?'
          }
          // The native list's sort keys (repositories/projects.js SORTABLE). upsert writes each on
          // every row, because an ORDER BY drops rows that lack its field.
          {
            path: '/dateUpdated/?'
          }
          {
            path: '/sector/?'
          }
          {
            path: '/proponentName/?'
          }
          {
            path: '/projectType/?'
          }
          {
            path: '/region/?'
          }
          {
            path: '/currentPhaseName/name/?'
          }
          {
            path: '/eacDecisionSort/?'
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
            // documents.js filters on it for the extraction-failure count on /db/stats.
            path: '/contentExtractionError/?'
          }
          // No '/id/?': Cosmos rejects a policy that names the system property, which is always
          // indexed, so the by-id cross-partition fallback is already served.
          {
            path: '/sourceSystem/?'
          }
          {
            path: '/eagleId/?'
          }
          {
            // GET /documents/recent-uploads sorts on it. A single-property ORDER BY needs a range
            // index on that exact path; without this the query is rejected outright.
            path: '/dateUploaded/?'
          }
          {
            // The same query leaves out update images by documentSource; unindexed, that filter
            // scans every partition.
            path: '/documentSource/?'
          }
          {
            // documents.js listParentFieldsPending and countParentFieldsPending filter on it.
            path: '/parentFieldsPending/?'
          }
          {
            path: '/pdfTitle/lease/expiresAt/?'
          }
          // Intake sweep paths. A new path reindexes the container online, even where intake is off.
          {
            path: '/scanStatus/?'
          }
          {
            path: '/createdAt/?'
          }
          {
            path: '/scannedAt/?'
          }
        ]
        excludedPaths: noIndex
      }
    }
  }
}

// Eagle `RecentActivity`. No TTL: an update is retired by unpublishing it.
resource updatesContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'updates'
  properties: {
    resource: {
      id: 'updates'
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
            path: '/projectId/?'
          }
          {
            path: '/read/[]/?'
          }
          {
            path: '/isPublished/?'
          }
          {
            path: '/dateAdded/?'
          }
          // The public list sorts on it, and an ORDER BY on an unindexed path cannot be served.
          {
            path: '/dateUpdated/?'
          }
          // The home strip splits the page on it, pinned rows first.
          {
            path: '/pinned/?'
          }
          // The publish gate every non-staff read carries (repositories/updates.js liveCriteria).
          {
            path: '/status/?'
          }
          {
            path: '/publishDate/?'
          }
          // Native list sort keys; the mirror writes both as null when Eagle sends none.
          {
            path: '/headline/?'
          }
          {
            path: '/type/?'
          }
          {
            path: '/notifiedAt/?'
          }
          // The scheduled announce's retry queries (repositories/updates.js listDueForNotify).
          {
            path: '/notifiedBy/?'
          }
          {
            path: '/notifyClaimedAt/?'
          }
          {
            path: '/notifySentAt/?'
          }
          {
            path: '/notifyFailedAt/?'
          }
          {
            path: '/notifyCancelledAt/?'
          }
          {
            path: '/notifyAttempts/?'
          }
          {
            path: '/complianceAndEnforcement/?'
          }
          // The mirror's lookup of a DEMI row by Eagle id, and the sync-out pending list. Deploy before the API
          // that queries them, on test first: without them each query scans the container.
          {
            path: '/sourceSystem/?'
          }
          {
            path: '/eagleId/?'
          }
        ]
        excludedPaths: noIndex
      }
    }
  }
}

// Public comment periods (Eagle `CommentPeriod`), mirrored on every eagle-api write. /projectId
// because the only list is "the periods of this project", the same shape as documents.
resource commentPeriodsContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'commentPeriods'
  properties: {
    resource: {
      id: 'commentPeriods'
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
            path: '/dateStarted/?'
          }
          {
            path: '/dateCompleted/?'
          }
          {
            path: '/dateAdded/?'
          }
        ]
        excludedPaths: noIndex
      }
    }
  }
}

// /periodId, not /projectId: a busy project's comments in one partition would near the 20 GB cap.
resource commentsContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'comments'
  properties: {
    resource: {
      id: 'comments'
      partitionKey: {
        paths: [
          '/periodId'
        ]
        kind: 'Hash'
      }
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [
          {
            path: '/periodId/?'
          }
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
            path: '/dateAdded/?'
          }
          {
            path: '/commentId/?'
          }
        ]
        excludedPaths: noIndex
      }
    }
  }
}

// Kept out of `projects`, or they would show in the project list, the map and the projects index.
resource notificationsContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'notifications'
  properties: {
    resource: {
      id: 'notifications'
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
            path: '/read/[]/?'
          }
          {
            path: '/isPublished/?'
          }
          {
            path: '/notificationReceivedDate/?'
          }
          {
            path: '/name/?'
          }
          // The four facets the public notifications page filters by.
          {
            path: '/type/?'
          }
          {
            path: '/region/?'
          }
          {
            path: '/pcp/?'
          }
          {
            path: '/decision/?'
          }
          // Native list sort key; the mirror writes null when Eagle sends none.
          {
            path: '/proponent/?'
          }
          {
            path: '/subType/?'
          }
          // The mirror's lookup of a DEMI row by Eagle id, and the sync-out pending list.
          {
            path: '/sourceSystem/?'
          }
          {
            path: '/eagleId/?'
          }
        ]
        excludedPaths: noIndex
      }
    }
  }
}

// Eagle `List` and `Organization` in one container, discriminated by `kind`. Both are small
// anonymous lookups read by kind and nothing else, so /kind is the whole query shape.
resource listsContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'lists'
  properties: {
    resource: {
      id: 'lists'
      partitionKey: {
        paths: [
          '/kind'
        ]
        kind: 'Hash'
      }
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [
          {
            path: '/kind/?'
          }
          {
            path: '/read/[]/?'
          }
          {
            path: '/isPublished/?'
          }
          {
            path: '/type/?'
          }
          {
            path: '/companyType/?'
          }
          {
            path: '/name/?'
          }
          // `List` rows only: eagle-public orders lookup dropdowns by /listOrder and narrows the
          // legislation lookups by /legislation. An ORDER BY on an unindexed path cannot be served.
          {
            path: '/listOrder/?'
          }
          {
            path: '/legislation/?'
          }
          {
            path: '/companyLegal/?'
          }
          {
            path: '/eagleId/?'
          }
        ]
        excludedPaths: noIndex
      }
    }
  }
}

// The mirror writes every sort key on every row, since an ORDER BY drops rows missing its field.
resource usersContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'users'
  properties: {
    resource: {
      id: 'users'
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
            path: '/read/[]/?'
          }
          {
            path: '/displayName/?'
          }
          {
            path: '/orgName/?'
          }
          {
            path: '/email/?'
          }
          {
            path: '/phoneNumber/?'
          }
        ]
        excludedPaths: noIndex
      }
    }
  }
}

// Eagle `Group`, a project's contact group. Listed per project, so /projectId is the partition.
// /name is the `sort` key; the mirror writes it on every row, so that ORDER BY drops none.
resource groupsContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'groups'
  properties: {
    resource: {
      id: 'groups'
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
            path: '/name/?'
          }
        ]
        excludedPaths: noIndex
      }
    }
  }
}

// One document per Track work, with its phases and milestones. Listed per project, so /projectId
// is the partition. No /read/[]/?: works carry no read gate of their own, the project row's applies.
resource worksContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'works'
  properties: {
    resource: {
      id: 'works'
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
            path: '/workTypeId/?'
          }
          {
            path: '/deleted/?'
          }
        ]
        excludedPaths: noIndex
      }
    }
  }
}

// Eagle `Inspection`, `InspectionElement` and `InspectionItem` in one container, discriminated by
// `kind`. /inspection keeps one inspection and everything under it in one logical partition.
resource inspectionsContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'inspections'
  properties: {
    resource: {
      id: 'inspections'
      partitionKey: {
        paths: [
          '/inspection'
        ]
        kind: 'Hash'
      }
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [
          {
            path: '/kind/?'
          }
          {
            path: '/inspection/?'
          }
          {
            path: '/projectId/?'
          }
          {
            path: '/element/?'
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

// /type has three values, fine here: the only list query filters on it and the container is a
// few MB, since full GeoJSON is served as a static asset.
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

// Each sync re-upserts fires still in the DataBC feed, so dropped fires expire by TTL. No spatial
// index: nothing reads this container, the fire layer reads DataBC WFS.
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
      }
    }
  }
}

// The id is the key's public keyId, so verification is a point read. /hash stays out of the index,
// and no TTL: expired keys stay visible for the audit trail.
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

// /party/id: every request reads one party's grants. No TTL: an expired grant stays visible for
// the audit trail, and middleware checks `end`.
resource credentialsContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'credentials'
  properties: {
    resource: {
      id: 'credentials'
      partitionKey: {
        paths: [
          '/party/id'
        ]
        kind: 'Hash'
      }
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [
          {
            path: '/scope/ids/[]/?'
          }
          {
            path: '/batchId/?'
          }
          {
            path: '/grantedAt/?'
          }
        ]
        excludedPaths: [
          {
            path: '/*'
          }
          {
            path: '/_etag/?'
          }
        ]
      }
    }
  }
}

// Served to the public verbatim, so it stays out of `apikeys`. One item, read by id, never queried.
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

// Partitioned on /id (the code itself): redirect point read and code-clash create are single-
// partition. No TTL — print/QR links are permanent by design.
resource linksContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'links'
  properties: {
    resource: {
      id: 'links'
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
            path: '/createdAt/?'
          }
        ]
        excludedPaths: [
          {
            path: '/*'
          }
          {
            path: '/_etag/?'
          }
        ]
      }
    }
  }
}

// One row per project, id = project id. Only /generatedAt is indexed, for the refresh pass.
resource projectSummariesContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'projectSummaries'
  properties: {
    resource: {
      id: 'projectSummaries'
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
            path: '/generatedAt/?'
          }
        ]
        excludedPaths: [
          {
            path: '/*'
          }
          {
            path: '/_etag/?'
          }
        ]
      }
    }
  }
}

// Partitioned on the owner's IDIR username; the id carries the type (`lasso:<slug>`).
resource userDataContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'userdata'
  properties: {
    resource: {
      id: 'userdata'
      partitionKey: {
        paths: [
          '/userId'
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
            path: '/updatedAt/?'
          }
        ]
        excludedPaths: [
          {
            path: '/*'
          }
          {
            path: '/ring/*'
          }
          {
            path: '/_etag/?'
          }
        ]
      }
    }
  }
}

// The job id is the requester's capability token. Per-item ttl outlives the zip, so the sweep still
// sees the owner. Also holds `quota:<requester>` counter rows.
resource bulkDownloadsContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'bulkDownloads'
  properties: {
    resource: {
      id: 'bulkDownloads'
      partitionKey: {
        paths: [
          '/id'
        ]
        kind: 'Hash'
      }
      defaultTtl: -1
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [
          {
            // The cleanup sweep, the only query here, filters on both of these.
            path: '/status/?'
          }
          {
            path: '/finishedAt/?'
          }
        ]
        // `/*` already excludes the id list, the access snapshot, the errors and the parts.
        excludedPaths: noIndex
      }
    }
  }
}

// Rows set their own 7-day ttl; `-1` only turns TTL on. Default indexing, since TTL needs it.
resource edgeBansContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'edgeBans'
  properties: {
    resource: {
      id: 'edgeBans'
      partitionKey: {
        paths: [
          '/id'
        ]
        kind: 'Hash'
      }
      defaultTtl: -1
    }
  }
}

// The portal cannot manage Cosmos data-plane role assignments, so they live here.

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

// NoSQL needs groupIds 'Sql' and zone privatelink.documents.azure.com; 'MongoDB' never resolves.

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

// Control-plane changes to the account, which the app cannot see and the landing-zone policy ships
// only to a central workspace we cannot read.
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
    // DataPlaneRequests logs one row per operation (~1.13M on a re-extraction): incidents only.
    logs: [
      {
        category: 'ControlPlaneRequests'
        enabled: true
      }
    ]
  }
}

// No connection-string output: local auth is off, endpoint plus managed identity is enough.
output cosmosAccountId string = cosmosAccount.id
output cosmosAccountName string = cosmosAccount.name
output cosmosEndpoint string = cosmosAccount.properties.documentEndpoint
output databaseName string = database.name
output privateDnsZoneName string = privateDnsZoneName
