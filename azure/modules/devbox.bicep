// Dev-access VM — the replacement for the App Service SSH tunnel, which was the only route to the
// private Cosmos and AI Search data planes and dies with the legacy B1/B3 apps (Flex has no SSH).
//
// Three ways in, none of them a network path from a laptop: `az vm run-command invoke` over the ARM
// control plane for scripts, Azure Bastion (Developer SKU, portal shell only) for an interactive
// session, and blob upload from inside for files. So: no public IP, and no SSH port ever opened.
//
// It runs as the API's OWN identity, passed in — scripts then have exactly the app's Cosmos, Key
// Vault, Search and storage access, and nothing more. Search *admin* stays temporary through
// scripts/with-search-admin.sh, same as everywhere else.

@description('Location for the VM and its NIC')
param location string = resourceGroup().location

@description('Environment name (e.g. dev, test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

@description('VM name. Bastion and every run-command address it by this.')
param vmName string = 'demi-devbox-${environmentName}'

// Non-delegated landing-zone subnet, and it already carries an NSG — so this module declares none.
// A second NSG on the same subnet is not additive; it replaces the landing zone's.
@description('Existing landing-zone subnet the NIC lands in. Must have line of sight to the private endpoints.')
param subnetId string

@description('Linux admin user. Owns the repo clone under /opt.')
param adminUsername string = 'demi'

// REQUIRED even though nothing SSHes in: the Compute API refuses a Linux VM with neither a password
// nor a key. Throwaway is fine — access is Bastion and run-command. Never committed; the param file
// reads it from the environment.
@description('SSH public key for the admin user. No password authentication is configured.')
param sshPublicKey string

@description('Resource ID of the user-assigned managed identity the scripts run as')
param identityId string

@description('Client ID of that identity. Exported as AZURE_CLIENT_ID so @azure/identity picks it.')
param identityClientId string

// Baked, not read back off the Flex app at runtime: `az functionapp config appsettings list` needs
// `Microsoft.Web/sites/config/list/action`, which no read-only role carries and this identity does
// not hold (verified against demi-identity-test, 2026-09-01). main.bicep passes the same expressions
// it passes the app, so the two cannot drift.
@description('Cosmos DB for NoSQL document endpoint, exported by demi-env.')
param cosmosEndpoint string

@description('Cosmos database holding the DEMI containers')
param cosmosDatabase string = 'demi'

@description('Azure AI Search endpoint. Empty makes every delete no-op against the index rather than fail, so set it.')
param searchEndpoint string = ''

@description('Upstream eagle-api the seed and reconcile scripts read.')
param eagleApiBase string

// Placeholders rather than interpolation: a Bicep multi-line string does not interpolate, and the
// shell below is full of `$` that a single-line string would fight.
var cloudInitTemplate = '''
#cloud-config
package_update: true
packages:
  - git
  - curl
  - gnupg
write_files:
  - path: /usr/local/bin/demi-env
    permissions: '0755'
    content: |
      #!/bin/sh
      # eval "$(demi-env)" primes a shell for the repo scripts.
      # --client-id, because the VM has ONLY a user-assigned identity: with no id argument the CLI
      # asks IMDS for a system-assigned one that does not exist. set -e so that failure stops here
      # rather than printing a half-primed environment that every later az command then fails on.
      set -e
      az login --identity --client-id __CLIENT_ID__ --allow-no-subscriptions --output none
      cat <<'ENV'
      export AZURE_CLIENT_ID=__CLIENT_ID__
      export COSMOS_ENDPOINT=__COSMOS_ENDPOINT__
      export COSMOS_NOSQL_DATABASE=__COSMOS_DATABASE__
      export SEARCH_ENDPOINT=__SEARCH_ENDPOINT__
      export EAGLE_API_BASE=__EAGLE_API_BASE__
      ENV
runcmd:
  - curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /usr/share/keyrings/microsoft.gpg
  - echo "deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ noble main" > /etc/apt/sources.list.d/azure-cli.list
  - curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  - apt-get install -y azure-cli nodejs
  - corepack enable
  - git clone --depth 1 https://github.com/digitalspace/eagle-demi /opt/eagle-demi
  - chown -R __ADMIN_USER__:__ADMIN_USER__ /opt/eagle-demi
  - sudo -u __ADMIN_USER__ env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 bash -lc 'cd /opt/eagle-demi && yarn install'
'''

var cloudInit = replace(
  replace(
    replace(
      replace(
        replace(
          replace(cloudInitTemplate, '__CLIENT_ID__', identityClientId),
          '__COSMOS_ENDPOINT__', cosmosEndpoint
        ),
        '__COSMOS_DATABASE__', cosmosDatabase
      ),
      '__SEARCH_ENDPOINT__', searchEndpoint
    ),
    '__EAGLE_API_BASE__', eagleApiBase
  ),
  '__ADMIN_USER__', adminUsername
)

// Its own NIC. Reusing one left behind by a deleted VM carries that VM's IP config and, worse, its
// NSG association.
resource nic 'Microsoft.Network/networkInterfaces@2023-11-01' = {
  name: '${vmName}-nic'
  location: location
  tags: tags
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          subnet: {
            id: subnetId
          }
        }
      }
    ]
  }
}

resource devbox 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: vmName
  location: location
  tags: tags
  // USER-assigned only, same reasoning as the API app: the grants exist before the VM and survive it
  // being deleted and rebuilt.
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    hardwareProfile: {
      vmSize: 'Standard_B1s'
    }
    storageProfile: {
      // Gen2. `server-gen1` is the Gen1 sku of the same offer, and Bastion/Trusted Launch want Gen2.
      imageReference: {
        publisher: 'Canonical'
        offer: 'ubuntu-24_04-lts'
        sku: 'server'
        version: 'latest'
      }
      osDisk: {
        createOption: 'FromImage'
        diskSizeGB: 30
        managedDisk: {
          storageAccountType: 'Standard_LRS'
        }
      }
    }
    osProfile: {
      computerName: vmName
      adminUsername: adminUsername
      linuxConfiguration: {
        disablePasswordAuthentication: true
        ssh: {
          publicKeys: [
            {
              path: '/home/${adminUsername}/.ssh/authorized_keys'
              keyData: sshPublicKey
            }
          ]
        }
      }
      // cloud-init needs egress to packages.microsoft.com, deb.nodesource.com, github.com and the
      // npm registry through the hub firewall. Without it the VM boots and demi-env is the only
      // thing on it that works.
      customData: base64(cloudInit)
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: nic.id
        }
      ]
    }
  }
}

// Deallocate discipline for the session somebody forgets to end. This is the portal's "Auto-shutdown"
// feature, and it reaches Stopped (deallocated) — compute billing stops, which is the whole point;
// Learn's how-to page never uses the word, the states-billing table is what makes it true.
resource autoShutdown 'Microsoft.DevTestLab/schedules@2018-09-15' = {
  name: 'shutdown-computevm-${vmName}'
  location: location
  tags: tags
  properties: {
    status: 'Enabled'
    taskType: 'ComputeVmShutdownTask'
    targetResourceId: devbox.id
    dailyRecurrence: {
      time: '1900'
    }
    timeZoneId: 'Pacific Standard Time'
    // Off: the mail would go to whoever owns the schedule, not to whoever left the box running.
    notificationSettings: {
      status: 'Disabled'
      timeInMinutes: 30
    }
  }
}

output devboxName string = devbox.name
// What `az vm run-command invoke --ids` and the Bastion target take.
output devboxId string = devbox.id
output devboxPrivateIp string = nic.properties.ipConfigurations[0].properties.privateIPAddress
