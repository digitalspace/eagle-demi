using './email.bicep'

param environmentName = 'dev'
param location = 'canadacentral'

// Landing-zone VNet subnets in c4b0a8-dev-networking — same ones main.bicepparam names.
param privateEndpointSubnetId = '/subscriptions/d2f8d048-2af3-44fd-81cc-858c040001f2/resourceGroups/c4b0a8-dev-networking/providers/Microsoft.Network/virtualNetworks/c4b0a8-dev-vwan-spoke/subnets/c4b0a8-dev-cond-ext-pe-subnet'
param appServiceSubnetId = '/subscriptions/d2f8d048-2af3-44fd-81cc-858c040001f2/resourceGroups/c4b0a8-dev-networking/providers/Microsoft.Network/virtualNetworks/c4b0a8-dev-vwan-spoke/subnets/c4b0a8-dev-cond-ext-webapp-subnet'

// Secrets are deploy-time CLI arguments, never committed — repo is public.
param pgAdminPassword = readEnvironmentVariable('EPIC_EMAIL_PG_PASSWORD', '')
param listmonkAdminPassword = readEnvironmentVariable('EPIC_EMAIL_LISTMONK_PASSWORD', '')

// Set after the Entra app registration exists (second pass): SP object id for SMTP auth.
param smtpPrincipalId = readEnvironmentVariable('EPIC_EMAIL_SMTP_PRINCIPAL_ID', '')
