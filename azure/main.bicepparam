using './main.bicep'

param environmentName = 'dev'
param location = 'canadacentral'
param minioHost = 'minio-6cdc9e-dev.apps.silver.devops.gov.bc.ca'
param minioAccessKey = 'minio'
param minioSecretKey = 'minio123'

// The landing zone's VNet, in c4b0a8-dev-networking — another resource group, not managed here.
// Both subnets already exist and are already in use: the Cosmos and Search private endpoints sit
// in the first, demi-api-dev's VNet integration in the second. Public network access is denied by
// policy, so leaving these empty builds an environment that is unreachable rather than public.
param privateEndpointSubnetId = '/subscriptions/d2f8d048-2af3-44fd-81cc-858c040001f2/resourceGroups/c4b0a8-dev-networking/providers/Microsoft.Network/virtualNetworks/c4b0a8-dev-vwan-spoke/subnets/c4b0a8-dev-cond-ext-pe-subnet'
param appServiceSubnetId = '/subscriptions/d2f8d048-2af3-44fd-81cc-858c040001f2/resourceGroups/c4b0a8-dev-networking/providers/Microsoft.Network/virtualNetworks/c4b0a8-dev-vwan-spoke/subnets/c4b0a8-dev-cond-ext-webapp-subnet'

// budgetAmount deliberately unset — main.bicep's default is the single source of truth for the
// ceiling. Setting it here silently reverted the raise to 100 on the next deployment.
// Both — see main.test.bicepparam.
param contactEmails = [
  'daniel@digitalspace.ca'
  'Daniel.T.Truong@gov.bc.ca'
]
