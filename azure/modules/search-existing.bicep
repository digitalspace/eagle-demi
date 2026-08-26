// The two things a search service this template does not deploy still needs from it: the data-plane
// role assignment for the API identity, and the outbound shared private link to our Cosmos account.
// Nothing else about the service is touched — no identity, no `semanticSearch`, no private endpoint.
//
// A module rather than four lines in main.bicep: a roleAssignment name has to be calculable before
// the deployment starts, and main.bicep only learns the principal id from the identity module's
// output. Crossing a module boundary turns that output into a parameter, which is calculable.
//
// The guid() formula is deliberately identical to modules/ai-search.bicep's, so the assignment this
// makes and the one that module makes are the SAME resource — flipping `deploySearch` later cannot
// produce a second, differently-named assignment for the same principal, role and scope (ARM
// rejects that as RoleAssignmentExists).

@description('Name of the existing search service.')
param searchName string

@description('Principal granted read and write of the documents in an index. Not Search Service Contributor — the API never defines an index.')
param apiPrincipalId string

@description('Environment name, used to name the shared private link.')
param environmentName string

@description('Resource id of the Cosmos account the indexer reads. Empty skips the shared private link.')
param cosmosAccountId string = ''

var searchIndexDataContributor = '8ebe5a00-799e-43f5-93ac-243d3dce84a7'

resource search 'Microsoft.Search/searchServices@2025-05-01' existing = {
  name: searchName
}

resource searchDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: search
  name: guid(search.id, apiPrincipalId, searchIndexDataContributor)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      searchIndexDataContributor
    )
    principalId: apiPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Outbound private link from the indexer to Cosmos. Shape copied verbatim from
// modules/ai-search.bicep, which owns the same declaration for the environments that DO deploy the
// service — same `Sql` group id (the NoSQL API, NOT `MongoDB`), same name, so flipping `deploySearch`
// later cannot mint a second link.
//
// Without it there is no route at all: `demi-cosmos-<env>` is publicNetworkAccess: Disabled, so an
// indexer on the public execution environment cannot connect, and the failure looks like a
// connection error rather than a permissions one.
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
