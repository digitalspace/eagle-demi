using 'modules/ai-search.bicep'

// The phase-1 parameter set for `demi-search-prod`, committed so the values are not carried in
// somebody's shell history. The prod deploy is a hand-run `az deployment group create` — there is no
// CI path to production infrastructure and there is deliberately not going to be one — so an
// operator who omits a parameter gets its default, and for `semanticSearch` the default is 'free'.
//
//   az deployment group create -g rg-demi-prod \
//     -f azure/modules/ai-search.bicep -p azure/ai-search.prod.bicepparam

param location = 'canadacentral'
param environmentName = 'prod'
param tags = {}

// Both take eagle-search's identity. There is no DEMI identity in c4b0a8-prod, and there does not
// need to be: `identityId` exists for the Cosmos indexer, and prod runs no indexer — nothing pulls
// from Cosmos there. `apiPrincipalId` is the one that matters, and it is what the module grants
// Search Index Data Contributor: eagle-search-api-prod queries this service as that identity.
param identityId = '/subscriptions/be5924ac-1083-4a1b-be92-7b444882cfd9/resourceGroups/rg-eagle-search-prod/providers/Microsoft.ManagedIdentity/userAssignedIdentities/eagle-search-identity-prod'
param apiPrincipalId = '20211fb1-1d7c-43ab-ae57-fbcd6a5034e7'

// Reuses the subnet pe-eagle-search-prod already sits in. The App Service that queries this service
// is VNet-integrated into c4b0a8-prod-vwan-spoke, so the endpoint has to land in that VNet; private
// DNS is managed by the landing zone, not by this template.
param peSubnetId = '/subscriptions/be5924ac-1083-4a1b-be92-7b444882cfd9/resourceGroups/c4b0a8-prod-networking/providers/Microsoft.Network/virtualNetworks/c4b0a8-prod-vwan-spoke/subnets/c4b0a8-prod-cond-ext-pe-subnet'

// Empty: no indexer, so no shared private link to any Cosmos account.
param cosmosAccountId = ''

// NOT 'free'. The free tier latches off after a 402 and silently drops that worker to BM25, and
// adopting semantic ranking at all is a retrievability/select-list decision that does not belong in
// a cutover. eagle-search-prod runs with it disabled today; this keeps the two in step.
param semanticSearch = 'disabled'
