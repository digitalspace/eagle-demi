// Microsoft Foundry account — the summariser behind `GET /api/search/summary`.
//
// Step 5 of the search pipeline and the only step that touches a model. Retrieval stays classic
// lexical BM25 in `demi-search-*`: this account never selects documents, never re-ranks and never
// rewrites a query. Delete it and search still works; only the summary panel disappears. Full
// decision, rejected alternatives and limitations: wiki ADR-006.
//
// COST IS PER TOKEN, NOT PER HOUR. Unlike AI Search Basic — a fixed ~$75-81/mo whether queried or
// idle — this account bills only what is asked of it. At 8 chunks x 1500 chars that is roughly
// $0.0006 a query, so ~$0.63/mo at a thousand. The bill scales with query volume, which is why the
// endpoint is privileged-only in v1 and why `summarize.js` logs prompt/completion tokens on every
// call: without that meter the budget question is unanswerable.
//
// ‼️ BEFORE DEPLOYING: provisioning a Microsoft.CognitiveServices account is what the BC Gov AI
// Services Hub process governs — https://bcgov.github.io/ai-hub-tracking/. It was skipped for
// `demi-search-dev`. Submit the request first this time.

@description('Location for the Foundry account. See the canadaeast note below — this is deliberately NOT the resource group location.')
param location string = 'canadaeast'

@description('Environment name (e.g. dev, test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

@description('Principal ID of the user-assigned managed identity the API authenticates as')
param identityPrincipalId string

@description('Subnet ID for the inbound private endpoint. Required in this landing zone — public network access is denied by policy.')
param peSubnetId string = ''

@description('Region of the PE subnet. A private endpoint lives with its SUBNET, not with the resource it targets — this is canadacentral while the account is canadaeast.')
param peLocation string = resourceGroup().location

@description('Model to deploy. A small chat model: the job is compressing eight retrieved chunks into three sentences, not open-ended reasoning.')
param modelName string = 'gpt-5-mini'

@description('Model version. Pinned rather than floating, so a summary that regresses is attributable to a deliberate change.')
param modelVersion string

@description('Tokens-per-minute, in thousands. The hard ceiling on spend and the reason a runaway loop cannot produce a surprise bill.')
param capacity int = 10

// WHY canadaeast, when every other resource in this group is canadacentral.
//
// canadacentral has NO Standard (regional) pay-per-token deployments — only `global-standard`,
// which routes inference to any Microsoft region worldwide. For BC Gov data that is a residency
// decision, not a performance one. canadaeast is the only Standard option in the Canada geography,
// so it is the only way to keep inference in-country.
//
// Private endpoints work cross-region, so the PE below still lands on the canadacentral PE subnet
// and the API reaches this account over the existing VNet. Nothing else has to move.
var foundryName = 'demi-foundry-${environmentName}'

resource foundry 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: foundryName
  location: location
  tags: tags
  kind: 'AIServices'
  sku: {
    name: 'S0'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    // Required for token-based auth to work at all: the data-plane URL is derived from it.
    customSubDomainName: foundryName

    // MANDATORY. The landing-zone policy `Deny-PublicPaaSEndpoints` rejects the deployment outright
    // with `RequestDisallowedByPolicy` if this is Enabled — the resource is never created, so the
    // failure arrives before anything exists to inspect.
    publicNetworkAccess: 'Disabled'

    // Keyless, exactly like Cosmos and AI Search. There is no key to rotate, to leak into app
    // settings, or to commit to a public repo by accident. Auth is the user-assigned identity via
    // the role assignment below.
    disableLocalAuth: true

    networkAcls: {
      defaultAction: 'Deny'
    }
  }
}

// The model deployment. `Standard` — see the canadaeast note above; `GlobalStandard` would defeat
// the reason this account is in canadaeast at all.
resource deployment 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {
  parent: foundry
  name: modelName
  sku: {
    name: 'Standard'
    capacity: capacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: modelName
      version: modelVersion
    }
  }
}

// Cognitive Services User — the data-plane read role. Enough to call chat completions on a
// deployment, and nothing else: it cannot create, modify or delete deployments, so a compromised
// API instance cannot provision itself a larger model.
var cognitiveServicesUser = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'a97b65f3-24c7-4388-baec-2e87135dc908'
)

resource identityRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: foundry
  name: guid(foundry.id, identityPrincipalId, cognitiveServicesUser)
  properties: {
    roleDefinitionId: cognitiveServicesUser
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Inbound private endpoint — the only route to the data plane now that public access is denied.
//
// No DNS zone group here, for the same reason as `ai-search.bicep`: this landing zone attaches one
// by POLICY (`deployedByPolicy`) from a central DNS subscription this one cannot read. Declaring
// our own would create a second, competing record set.
//
// The A-record appears roughly TEN MINUTES after the deployment returns. A DNS check before then
// resolves the public address and looks exactly like a missing zone — it is not. Wait, then retest.
// NOTE the location: `peLocation`, not `location`. A private endpoint is a NIC in the subnet, so it
// must be created in the subnet's region — canadacentral — even though the account it fronts lives
// in canadaeast. Using `location` here fails deployment outright.
resource foundryPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = if (!empty(peSubnetId)) {
  name: 'pe-${foundryName}'
  location: peLocation
  tags: tags
  properties: {
    subnet: {
      id: peSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'plsc-${foundryName}'
        properties: {
          privateLinkServiceId: foundry.id
          groupIds: [
            'account'
          ]
        }
      }
    ]
  }
}

output foundryName string = foundry.name
output foundryEndpoint string = foundry.properties.endpoint
output foundryId string = foundry.id
output deploymentName string = deployment.name
