using './email.bicep'

param environmentName = 'test'
param location = 'canadacentral'

// Landing-zone VNet subnets in c4b0a8-test-networking — same ones main.test.bicepparam names.
// Note the app-service subnet is NOT the dev name: test calls it snet-app-service.
param privateEndpointSubnetId = '/subscriptions/7897ceb1-9a86-4639-87d7-7f9ff67142b3/resourceGroups/c4b0a8-test-networking/providers/Microsoft.Network/virtualNetworks/c4b0a8-test-vwan-spoke/subnets/c4b0a8-test-cond-ext-pe-subnet'
param appServiceSubnetId = '/subscriptions/7897ceb1-9a86-4639-87d7-7f9ff67142b3/resourceGroups/c4b0a8-test-networking/providers/Microsoft.Network/virtualNetworks/c4b0a8-test-vwan-spoke/subnets/snet-app-service'

// Secrets are deploy-time CLI arguments, never committed — repo is public.
param pgAdminPassword = readEnvironmentVariable('EPIC_EMAIL_PG_PASSWORD', '')
param listmonkAdminPassword = readEnvironmentVariable('EPIC_EMAIL_LISTMONK_PASSWORD', '')

// Set after the Entra app registration exists (second pass): SP object id for SMTP auth.
param smtpPrincipalId = readEnvironmentVariable('EPIC_EMAIL_SMTP_PRINCIPAL_ID', '')
