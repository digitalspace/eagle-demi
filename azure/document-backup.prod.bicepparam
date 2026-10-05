using 'modules/document-backup.bicep'

// Prod: rg-demi-prod in c4b0a8-prod. Deploy by hand from a tag checkout, owner only:
//   az deployment group create --subscription be5924ac-1083-4a1b-be92-7b444882cfd9 -g rg-demi-prod \
//     -f azure/modules/document-backup.bicep -p azure/document-backup.prod.bicepparam

param environmentName = 'prod'
param location = 'canadacentral'

// Same subnet as privateEndpointSubnetId in main.prod.bicepparam.
param peSubnetId = '/subscriptions/be5924ac-1083-4a1b-be92-7b444882cfd9/resourceGroups/c4b0a8-prod-networking/providers/Microsoft.Network/virtualNetworks/c4b0a8-prod-vwan-spoke/subnets/c4b0a8-prod-cond-ext-pe-subnet'

// Two years, unlocked. Extend before expiry if the originals are still needed.
param retentionDays = 730

param grantWriter = false
