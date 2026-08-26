// Search Index Data Contributor on a search service this template does not deploy.
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
