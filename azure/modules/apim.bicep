// API Management (Consumption) in front of the Flex API: key issuance, per-consumer rate limits and
// metering. NOT a security boundary — Consumption has no VNet, so `demi-api-fc-<env>` stays publicly
// reachable and the app still authenticates every caller itself.
//
// TWO APIs, not one. The SPA is anonymous, so `demi-api` sets subscriptionRequired: false; but the
// subscriptions doc contradicts itself on whether a key presented to such an API still resolves
// `context.Subscription` ("Considerations" says the key is ignored, the lookup algorithm says it is
// honoured). Machine callers therefore get their own path, `/machine`, where a subscription is
// required and resolution is unambiguous. Same backend, same code.

@description('Azure region.')
param location string = resourceGroup().location

param tags object = {}

@description('Instance name, e.g. demi-apim-test.')
param apimName string

@description('Publisher contact shown on service notifications. Same list the cost alerts use.')
param publisherEmail string

param publisherName string = 'BC EAO EPIC'

@description('Function App default host name, e.g. demi-api-fc-test.azurewebsites.net.')
param apiHostName string

@description('Vault holding the gateway secret. The APIM system identity is granted read on it.')
param keyVaultName string

@description('Name of the shared gateway secret in that vault.')
param gatewaySecretName string = 'apim-gateway-secret'

var backendUrl = 'https://${apiHostName}/api'
var machineApiName = 'demi-machine'

// Wildcard operations, NOT an OpenAPI import: swagger.yaml is partial and drifts per deploy, while
// the gateway is a pure proxy — the app owns routing. Without these APIM 404s every request.
var proxyMethods = [
  'GET'
  'POST'
  'PUT'
  'DELETE'
  'PATCH'
  'HEAD'
  'OPTIONS'
]

// Server-to-server consumers, one subscription each so a key can be rotated or revoked alone.
var machineConsumers = [
  'eagle-api'
]

resource apim 'Microsoft.ApiManagement/service@2024-05-01' = {
  name: apimName
  location: location
  tags: tags
  sku: {
    name: 'Consumption'
    capacity: 0
  }
  // System-assigned: a Key Vault named value cannot use a user-assigned identity.
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    publisherEmail: publisherEmail
    publisherName: publisherName
  }
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

// Key Vault Secrets User, same role the API's own identity holds (see key-vault.bicep).
var keyVaultSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'

resource secretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, apim.id, keyVaultSecretsUser)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUser)
    principalId: apim.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// The secret VALUE is created out of band — this repo is public and the vault is the source of
// truth. Through the ARM CONTROL plane, which the vault firewall and the guardrail policies
// demanding contentType/expiry do not apply to; the data plane (`az keyvault secret set`) is
// Forbidden against this private-endpoint-only vault:
//   az rest --method PUT --url "https://management.azure.com/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.KeyVault/vaults/<vault>/secrets/apim-gateway-secret?api-version=2023-07-01" --body '{"properties":{"value":"<random>"}}'
//
// APIM's trusted-service entry covers custom-domain certificates only, so whether a Consumption
// instance resolves this named value against a publicNetworkAccess:Disabled vault is UNVERIFIED
// until the first deploy; the fallback is a `secret: true` named value carrying the literal.
resource gatewaySecret 'Microsoft.ApiManagement/service/namedValues@2024-05-01' = {
  parent: apim
  name: 'gateway-secret'
  properties: {
    displayName: 'gateway-secret'
    secret: true
    keyVault: {
      secretIdentifier: 'https://${keyVaultName}${environment().suffixes.keyvaultDns}/secrets/${gatewaySecretName}'
    }
  }
  dependsOn: [
    secretsUser
  ]
}

// Anonymous path. The browser cannot hold a key, so nothing is required here; the app applies its
// own public/authenticated tiers exactly as it does on a direct call.
resource api 'Microsoft.ApiManagement/service/apis@2024-05-01' = {
  parent: apim
  name: 'demi-api'
  properties: {
    displayName: 'DEMI API'
    path: 'api'
    protocols: [
      'https'
    ]
    serviceUrl: backendUrl
    subscriptionRequired: false
  }
}

resource apiOperations 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = [for method in proxyMethods: {
  parent: api
  name: toLower(method)
  properties: {
    displayName: '${method} *'
    method: method
    urlTemplate: '/*'
  }
}]

// Machine path. Same backend, reached as /machine/<route> with Ocp-Apim-Subscription-Key.
resource machineApi 'Microsoft.ApiManagement/service/apis@2024-05-01' = {
  parent: apim
  name: machineApiName
  properties: {
    displayName: 'DEMI API (machine)'
    path: 'machine'
    protocols: [
      'https'
    ]
    serviceUrl: backendUrl
    subscriptionRequired: true
  }
}

resource machineApiOperations 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = [for method in proxyMethods: {
  parent: machineApi
  name: toLower(method)
  properties: {
    displayName: '${method} *'
    method: method
    urlTemplate: '/*'
  }
}]

resource machineProduct 'Microsoft.ApiManagement/service/products@2024-05-01' = {
  parent: apim
  name: 'machine'
  properties: {
    displayName: 'machine'
    description: 'Server-to-server consumers of the DEMI API.'
    subscriptionRequired: true
    approvalRequired: false
    state: 'published'
  }
}

resource machineProductApi 'Microsoft.ApiManagement/service/products/apis@2024-05-01' = {
  parent: machineProduct
  name: machineApiName
  dependsOn: [
    machineApi
  ]
}

// Per-subscription rate limit, no quota: the nightly reconcile bursts, and a monthly wall would
// fail it closed halfway through a run.
resource machineProductPolicy 'Microsoft.ApiManagement/service/products/policies@2024-05-01' = {
  parent: machineProduct
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: '''<policies>
  <inbound>
    <base />
    <rate-limit calls="300" renewal-period="60" />
  </inbound>
  <backend><base /></backend>
  <outbound><base /></outbound>
  <on-error><base /></on-error>
</policies>'''
  }
}

// Keys are generated by Azure and read with `az apim subscription list-keys` — never in this repo.
resource machineSubscriptions 'Microsoft.ApiManagement/service/subscriptions@2024-05-01' = [for consumer in machineConsumers: {
  parent: apim
  name: consumer
  properties: {
    displayName: consumer
    scope: machineProduct.id
    state: 'active'
  }
}]

// Global policy. The three backend headers are deleted first because the Function App host stays
// publicly reachable: anything a client sends under these names is attacker input.
// X-Client-Ip is the address APIM saw the request arrive from. Behind the gateway the last
// X-Forwarded-For hop is APIM, so it is the only way the app can tell two callers apart —
// src/utils/caller-ip.js reads it, and only on a request the gateway secret proves.
// No <base/> here: the global scope has no parent, so APIM rejects it; backend forwards explicitly.
resource globalPolicy 'Microsoft.ApiManagement/service/policies@2024-05-01' = {
  parent: apim
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: '''<policies>
  <inbound>
    <set-header name="X-Gateway-Secret" exists-action="delete" />
    <set-header name="X-APIM-Subscription" exists-action="delete" />
    <set-header name="X-Client-Ip" exists-action="delete" />
    <set-header name="X-Gateway-Secret" exists-action="override">
      <value>{{gateway-secret}}</value>
    </set-header>
    <set-header name="X-APIM-Subscription" exists-action="override">
      <value>@(context.Subscription?.Name ?? "")</value>
    </set-header>
    <set-header name="X-Client-Ip" exists-action="override">
      <value>@(context.Request.IpAddress)</value>
    </set-header>
  </inbound>
  <backend><forward-request /></backend>
  <outbound />
  <on-error />
</policies>'''
  }
  dependsOn: [
    gatewaySecret
  ]
}

output apimName string = apim.name
output gatewayUrl string = apim.properties.gatewayUrl
output principalId string = apim.identity.principalId
