// EPIC email service — dev prove-out. Standalone on purpose: azure/main.bicep documents the
// deployed DEMI estate and this is not part of it (yet). Deploys into the empty dev sandbox.
//
// Shape: ACS Email (send pipe, Canada data location, Azure-managed domain for the prove-out —
// swap to a custom gov.bc.ca domain after CITZ DNS) + listmonk (campaign/template UI for
// non-technical staff) on its own B1 Linux plan + PostgreSQL Flexible Server behind a private
// endpoint, which the landing zone's Deny-PublicPaaSEndpoints policy requires.
//
// Landing-zone rules honoured here (see wiki BC-Gov-Azure-Landing-Zone):
//   - No privatelink DNS zone declared: a DeployIfNotExists policy attaches the central one to
//     the PE (~10 min A-record lag; resolves to the disabled public IP until then).
//   - Postgres ships publicNetworkAccess Disabled; without the PE it is unreachable, not public.
//   - vnetRouteAllEnabled is FALSE on the app: subnets have no default internet egress, and
//     listmonk must reach Docker Hub and smtp.azurecomm.net:587. Only RFC1918 (the Postgres PE)
//     routes through the VNet; SMTP uses App Service's own public egress.
//
// Post-deploy configuration lives in listmonk's DB, not here — app.root_url, SMTP creds,
// Keycloak OIDC client, and the EAGLE Mail branding (see README.md and theme/). Trap: listmonk
// PUT /api/settings stores masked '••' secrets literally, so every settings write must re-send
// the real smtp[].password AND security.oidc.client_secret.

targetScope = 'resourceGroup'

@description('Target Azure region for regional resources (ACS itself is global + dataLocation).')
param location string = 'canadacentral'

@description('Environment name (dev, test, prod)')
param environmentName string = 'dev'

@description('Existing landing-zone subnet for the Postgres private endpoint.')
param privateEndpointSubnetId string

@description('Existing landing-zone subnet for App Service VNet integration.')
param appServiceSubnetId string

@description('Postgres admin login')
param pgAdminLogin string = 'listmonk'

@secure()
@description('Postgres admin password')
param pgAdminPassword string

@secure()
@description('listmonk super-admin password (bootstrap; user: value of listmonkAdminUser)')
param listmonkAdminPassword string

@description('listmonk super-admin username')
param listmonkAdminUser string = 'epicadmin'

@description('Object ID of the Entra service principal used for SMTP auth. Empty skips the role assignment (first pass, before the app registration exists).')
param smtpPrincipalId string = ''

var tags = {
  Project: 'EPIC'
  Application: 'epic-email'
  Environment: environmentName
  ManagedBy: 'Bicep'
  CostCenter: 'c4b0a8'
}

// ── ACS Email ────────────────────────────────────────────────────────────────
// location must be 'global'; dataLocation Canada is the residency knob.

resource emailService 'Microsoft.Communication/emailServices@2023-04-01' = {
  name: 'epic-email-${environmentName}'
  location: 'global'
  tags: tags
  properties: {
    dataLocation: 'Canada'
  }
}

// Azure-managed domain: instant, no DNS tickets, capped at 5 emails/min 10/hr — enough for the
// prove-out. The custom-domain resource replaces this after CITZ adds TXT/SPF/DKIM records.
resource managedDomain 'Microsoft.Communication/emailServices/domains@2023-04-01' = {
  parent: emailService
  name: 'AzureManagedDomain'
  location: 'global'
  tags: tags
  properties: {
    domainManagement: 'AzureManaged'
    userEngagementTracking: 'Disabled'
  }
}

resource commService 'Microsoft.Communication/communicationServices@2023-04-01' = {
  name: 'epic-comm-${environmentName}'
  location: 'global'
  tags: tags
  properties: {
    dataLocation: 'Canada'
    linkedDomains: [
      managedDomain.id
    ]
  }
}

// SMTP auth: the Entra app's SP needs read/write on the communication resource. The built-in
// 'Communication and Email Service Owner' role fits, and — unlike Contributor — is outside the
// landing zone's ABAC condition on roleAssignments/write, so this template can actually assign it.
resource smtpRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(smtpPrincipalId)) {
  name: guid(commService.id, smtpPrincipalId, 'smtp')
  scope: commService
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '09976791-48a7-449e-bb21-39d1a415f350' // Communication and Email Service Owner
    )
    principalId: smtpPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// ── PostgreSQL for listmonk ──────────────────────────────────────────────────

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: 'listmonk-pg-${environmentName}'
  location: location
  tags: tags
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: pgAdminLogin
    administratorLoginPassword: pgAdminPassword
    storage: {
      storageSizeGB: 32
    }
    network: {
      publicNetworkAccess: 'Disabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
  }
}

// Azure Postgres blocks CREATE EXTENSION unless allow-listed here; listmonk's schema needs
// pgcrypto and install dies with 'extension "pgcrypto" is not allow-listed' without this.
resource pgExtensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: postgres
  name: 'azure.extensions'
  properties: {
    value: 'PGCRYPTO'
    source: 'user-override'
  }
}

resource listmonkDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: 'listmonk'
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

resource pgPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = {
  name: 'pe-listmonk-pg-${environmentName}'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'pe-listmonk-pg-${environmentName}'
        properties: {
          privateLinkServiceId: postgres.id
          groupIds: [
            'postgresqlServer'
          ]
        }
      }
    ]
  }
}

// ── listmonk ─────────────────────────────────────────────────────────────────

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'listmonk-plan-${environmentName}'
  location: location
  tags: tags
  sku: {
    name: 'B1'
    tier: 'Basic'
  }
  properties: {
    reserved: true // Linux
  }
}

resource listmonk 'Microsoft.Web/sites@2023-12-01' = {
  name: 'epic-listmonk-${environmentName}'
  location: location
  tags: tags
  kind: 'app,linux,container'
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    virtualNetworkSubnetId: appServiceSubnetId
    siteConfig: {
      linuxFxVersion: 'DOCKER|listmonk/listmonk:latest'
      // Scheduled campaigns fire from listmonk's own in-process scheduler — the app must not be
      // unloaded between requests.
      alwaysOn: true
      vnetRouteAllEnabled: false
      // App Service's startup-command parser mangles quoted `sh -c "..."` strings (container
      // exits 2 in <1s, before any output), so the install-then-run chain lives in
      // /home/start.sh — seeded ONCE via Kudu VFS PUT (see azure/email/README note below):
      //   #!/bin/sh
      //   cd /listmonk
      //   ./listmonk --install --idempotent --yes && exec ./listmonk
      appCommandLine: 'sh /home/start.sh'
      appSettings: [
        {
          // Mounts the persistent /home share the startup script lives on.
          name: 'WEBSITES_ENABLE_APP_SERVICE_STORAGE'
          value: 'true'
        }
        {
          name: 'WEBSITES_PORT'
          value: '9000'
        }
        {
          // Hub resolver — without it privatelink names resolve to the (disabled) public IPs.
          name: 'WEBSITE_DNS_SERVER'
          value: '10.53.244.4'
        }
        {
          name: 'LISTMONK_app__address'
          value: '0.0.0.0:9000'
        }
        {
          name: 'LISTMONK_db__host'
          value: postgres.properties.fullyQualifiedDomainName
        }
        {
          name: 'LISTMONK_db__port'
          value: '5432'
        }
        {
          name: 'LISTMONK_db__user'
          value: pgAdminLogin
        }
        {
          name: 'LISTMONK_db__password'
          value: pgAdminPassword
        }
        {
          name: 'LISTMONK_db__database'
          value: 'listmonk'
        }
        {
          name: 'LISTMONK_db__ssl_mode'
          value: 'require'
        }
        {
          name: 'LISTMONK_ADMIN_USER'
          value: listmonkAdminUser
        }
        {
          name: 'LISTMONK_ADMIN_PASSWORD'
          value: listmonkAdminPassword
        }
      ]
    }
  }
}

output listmonkHostName string = listmonk.properties.defaultHostName
output emailServiceName string = emailService.name
output commServiceName string = commService.name
output managedDomainFromSender string = managedDomain.properties.fromSenderDomain
output postgresFqdn string = postgres.properties.fullyQualifiedDomainName
