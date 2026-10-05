using 'modules/document-backup.bicep'

// Test: c4b0a8-test-rg in c4b0a8-test. Deploy by hand:
//   az deployment group create --subscription 7897ceb1-9a86-4639-87d7-7f9ff67142b3 -g c4b0a8-test-rg \
//     -f azure/modules/document-backup.bicep -p azure/document-backup.test.bicepparam

param environmentName = 'test'
param location = 'canadacentral'

// Same subnet as privateEndpointSubnetId in main.test.bicepparam.
param peSubnetId = '/subscriptions/7897ceb1-9a86-4639-87d7-7f9ff67142b3/resourceGroups/c4b0a8-test-networking/providers/Microsoft.Network/virtualNetworks/c4b0a8-test-vwan-spoke/subnets/c4b0a8-test-cond-ext-pe-subnet'

// Short so the test account can be torn down after the trial run.
param retentionDays = 30

param grantWriter = false
