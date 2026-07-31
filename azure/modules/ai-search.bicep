// Azure AI Search — the Deep Search backend over extracted document text.
//
// Replaces both Cosmos native full-text search (ruled out: fuzzy `distance` is a silent no-op even
// with the preview enrolled, MIGRATION.md §F) and, eventually, Typesense (the chunk corpus outgrows
// the Container Apps memory ceiling). Cosmos stays the system of record; only the query layer
// lives here.
//
// CLASSIC LEXICAL SEARCH ONLY. No vector fields, no semantic ranker. Retrieval is BM25 over
// chunk text and AI is a summariser over the final top-N, not a retriever. The semantic ranker is
// billed on top of the tier and buys re-ranking nothing has shown a need for; vector search needs
// embeddings nothing generates. Fuzzy (`term~1`) is a plain GA query operator, and having it is
// the entire reason for this service.
//
// Cost: Basic is a FIXED monthly rate (~$75-81), charged whether it is queried or idle. The meter
// is how long the service exists, not how much it is used — which is why the budget moved to 100.

@description('Location for the search service')
param location string = resourceGroup().location

@description('Environment name (e.g. dev, test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

@description('Resource ID of the user-assigned managed identity the indexer authenticates as')
param identityId string

@description('Resource ID of the Cosmos DB account the indexer reads. Empty skips the shared private link (local development only).')
param cosmosAccountId string = ''

@description('Subnet ID for the inbound private endpoint. Required in this landing zone — public network access is denied by policy.')
param peSubnetId string = ''

// Basic, not Free: the Free tier supports neither a managed identity nor a shared private link,
// and `demi-cosmos-dev` has publicNetworkAccess disabled with local auth off — so Free cannot
// reach the data at all, at any size. Basic is the floor, not a choice about capacity.
var searchName = 'demi-search-${environmentName}'

resource search 'Microsoft.Search/searchServices@2025-05-01' = {
  name: searchName
  location: location
  tags: tags
  sku: {
    name: 'basic'
  }
  // The SAME user-assigned identity the API runs as. It already holds the Cosmos built-in Data
  // Contributor role at account scope, so the indexer inherits a working, already-tested grant
  // instead of a second one that could drift from it.
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    replicaCount: 1
    partitionCount: 1
    hostingMode: 'Default'

    // Keyless, like every other service here: admin and query keys are disabled outright and all
    // data-plane access is Entra RBAC. `authOptions` MUST be absent when local auth is disabled —
    // setting both is rejected.
    disableLocalAuth: true

    // NOT a choice. The landing-zone policy set `Deny-PublicPaaSEndpoints`
    // (`Deny-CognitiveSearch-PublicEndpoint`, assigned at the bcgov-managed-lz-live-landing-zones
    // management group) DENIES the deployment outright when this is anything but 'Disabled'.
    // Measured 2026-07-31: `publicNetworkAccess: 'enabled'` fails with RequestDisallowedByPolicy
    // before the service is ever created.
    //
    // The consequence is operational, not architectural: nothing outside the VNet can reach the
    // data plane, so index and indexer definitions cannot be POSTed from a workstation. They go in
    // from inside the VNet — the App Service's Kudu container resolves private endpoints
    // (verified: the Cosmos endpoint resolves to a 10.x address there).
    publicNetworkAccess: 'Disabled'
  }
}

// Inbound private endpoint — the only route to the data plane now that public access is denied.
//
// No DNS zone group is declared here on purpose. This landing zone attaches one by POLICY, named
// `deployedByPolicy`, pointing at a zone that lives in a central DNS subscription this one cannot
// read (that is how `pe-cosmos-nosql-dev` and `demi-mongo-pe` are wired). Declaring our own zone
// would create a second, competing record set.
resource searchPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = if (!empty(peSubnetId)) {
  name: 'pe-${searchName}'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: peSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'plsc-${searchName}'
        properties: {
          privateLinkServiceId: search.id
          groupIds: [
            'searchService'
          ]
        }
      }
    ]
  }
}

// Outbound private link from the indexer to Cosmos. Without this there is no route at all:
// `demi-cosmos-dev` is publicNetworkAccess: Disabled, so an indexer on the public execution
// environment cannot connect, and the failure looks like a connection error rather than a
// permissions one.
//
// `Sql` is the group id for the Cosmos NoSQL API — NOT `MongoDB`, which is the legacy account.
//
// This creates the connection in Pending. It MUST then be approved on the Cosmos side
// (`az cosmosdb private-endpoint-connection approve`) or nothing indexes.
resource cosmosLink 'Microsoft.Search/searchServices/sharedPrivateLinkResources@2025-05-01' = if (!empty(cosmosAccountId)) {
  parent: search
  name: 'demi-cosmos-${environmentName}-link'
  properties: {
    privateLinkResourceId: cosmosAccountId
    groupId: 'Sql'
    requestMessage: 'DEMI AI Search indexer reads the chunks container.'
  }
}

output searchName string = search.name
output searchEndpoint string = 'https://${search.name}.search.windows.net'
output searchId string = search.id
