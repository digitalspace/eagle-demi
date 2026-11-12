// Not a security boundary: Consumption has no VNet, so the Function App stays public and checks
// every caller. Two APIs because a key sent to a keyless API resolves ambiguously.

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

@description('Vault holding the gateway secret and the two analytics header values. The APIM system identity is granted read on it.')
param keyVaultName string

@description('Name of the shared gateway secret in that vault.')
param gatewaySecretName string = 'apim-gateway-secret'

// Read from the eagle-analytics deployment's apiHostName output, never composed.
@description('Absolute base URL of analytics-api-fc-<env>, e.g. https://analytics-api-fc-test.azurewebsites.net. Empty deploys no analytics API, which is every environment where eagle-analytics does not exist yet.')
param analyticsBackendUrl string = ''

@description('Key Vault URI of that header value. Not the value: APIM resolves the named value from the vault. The same secret eagle-analytics deploys as APIM_SHARED_HEADER_VALUE.')
param analyticsSharedHeaderSecretUri string = ''

@description('Key Vault URI of the second credential POST /audit demands, which eagle-analytics deploys as AUDIT_SHARED_HEADER_VALUE. A DIFFERENT secret from the one above on purpose: the write path is rotatable on its own, and a leaked ingest header must not buy an audit write.')
param analyticsAuditHeaderSecretUri string = ''

@description('Browser origins, scheme included, allowed on the analytics read routes. Named rather than `*` because those requests carry a Keycloak bearer; ingest stays open to any origin. Empty deploys no CORS policy on those routes, so no browser reaches them at all — fail closed.')
param analyticsBrowserOrigins array = []

var backendUrl = 'https://${apiHostName}/api'
var machineApiName = 'demi-machine'

// All three: the backend refuses requests missing either header, so a partial set deploys a dead API.
var analyticsDeployed = !empty(analyticsBackendUrl) && !empty(analyticsSharedHeaderSecretUri) && !empty(analyticsAuditHeaderSecretUri)
var analyticsApiName = 'analytics'
var analyticsMachineApiName = 'analytics-machine'

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
  'engage'
  'track'
]

// The Consumption tier emits no resource logs, so there is no GatewayLogs diagnostic setting here.
// Per-call gateway logging on this tier needs an Application Insights logger instead.
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
    // Unmodelled, every apply proposes turning the deprecated portal back on.
    legacyPortalStatus: 'Disabled'
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

// The value is set out of band with an ARM control-plane PUT (`az rest`); the data plane is
// Forbidden on this private vault.
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

// Rate limit, no quota: a monthly wall would cut the bursty nightly reconcile off mid-run.
var machineRateLimitPolicy = '''<policies>
  <inbound>
    <base />
    <rate-limit calls="300" renewal-period="60" />
  </inbound>
  <backend><base /></backend>
  <outbound><base /></outbound>
  <on-error><base /></on-error>
</policies>'''

resource machineProductPolicy 'Microsoft.ApiManagement/service/products/policies@2024-05-01' = {
  parent: machineProduct
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: machineRateLimitPolicy
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

// eagle-analytics operations are named, not wildcarded, so an undeclared route stays off the gateway.

// APIM reads the secret while creating the named value, so the read grant must exist first.
resource analyticsSharedHeader 'Microsoft.ApiManagement/service/namedValues@2024-05-01' = if (analyticsDeployed) {
  parent: apim
  name: 'analytics-shared-header'
  properties: {
    displayName: 'analytics-shared-header'
    secret: true
    keyVault: {
      secretIdentifier: analyticsSharedHeaderSecretUri
    }
  }
  dependsOn: [
    secretsUser
  ]
}

resource analyticsAuditHeader 'Microsoft.ApiManagement/service/namedValues@2024-05-01' = if (analyticsDeployed) {
  parent: apim
  name: 'analytics-audit-header'
  properties: {
    displayName: 'analytics-audit-header'
    secret: true
    keyVault: {
      secretIdentifier: analyticsAuditHeaderSecretUri
    }
  }
  dependsOn: [
    secretsUser
  ]
}

// Client copies of these headers are deleted first. Names must match APIM_SHARED_HEADER_NAME and
// AUDIT_SHARED_HEADER_NAME in eagle-analytics; only the machine API stamps the audit header.
var analyticsInboundHead = '''<policies>
  <inbound>
    <base />
    <!-- The global policy stamps DEMI's gateway secret on every request. It proves nothing to this
         backend and would sit in another app's request logs, so it comes off here. -->
    <set-header name="X-Gateway-Secret" exists-action="delete" />
    <set-header name="X-Analytics-Audit" exists-action="delete" />
    <set-header name="X-Analytics-Gateway" exists-action="delete" />
    <set-header name="X-Analytics-Gateway" exists-action="override">
      <value>{{analytics-shared-header}}</value>
    </set-header>
'''

var analyticsAuditStamp = '''    <set-header name="X-Analytics-Audit" exists-action="override">
      <value>{{analytics-audit-header}}</value>
    </set-header>
'''

var analyticsInboundTail = '''  </inbound>
  <backend><base /></backend>
  <outbound><base /></outbound>
  <on-error><base /></on-error>
</policies>'''

var analyticsPolicyXml = '${analyticsInboundHead}${analyticsInboundTail}'
var analyticsMachinePolicyXml = '${analyticsInboundHead}${analyticsAuditStamp}${analyticsInboundTail}'

// Anonymous path. A browser cannot hold a key; the app validates every batch itself.
resource analyticsApi 'Microsoft.ApiManagement/service/apis@2024-05-01' = if (analyticsDeployed) {
  parent: apim
  name: analyticsApiName
  properties: {
    displayName: 'EPIC Analytics'
    path: 'analytics'
    protocols: [
      'https'
    ]
    serviceUrl: analyticsBackendUrl
    subscriptionRequired: false
  }
}

resource analyticsEventsOperation 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = if (analyticsDeployed) {
  parent: analyticsApi
  name: 'events'
  properties: {
    displayName: 'POST /events'
    method: 'POST'
    urlTemplate: '/events'
  }
}

resource analyticsHealthOperation 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = if (analyticsDeployed) {
  parent: analyticsApi
  name: 'health'
  properties: {
    displayName: 'GET /health'
    method: 'GET'
    urlTemplate: '/health'
  }
}

// Keyless at the gateway; the app checks the Keycloak bearer. An APIM wildcard needs a segment, so
// `/dashboards` and `/dashboards/*` are separate operations.
var analyticsBearerOperations = [
  {
    name: 'query'
    method: 'POST'
    urlTemplate: '/query'
  }
  {
    name: 'query-schema'
    method: 'GET'
    urlTemplate: '/query/schema'
  }
  {
    name: 'dashboards-list'
    method: 'GET'
    urlTemplate: '/dashboards'
  }
  {
    name: 'dashboards-read'
    method: 'GET'
    urlTemplate: '/dashboards/*'
  }
  {
    name: 'dashboards-save'
    method: 'PUT'
    urlTemplate: '/dashboards/*'
  }
  {
    name: 'dashboards-delete'
    method: 'DELETE'
    urlTemplate: '/dashboards/*'
  }
]

resource analyticsBearerOperationResources 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = [for operation in analyticsBearerOperations: if (analyticsDeployed) {
  parent: analyticsApi
  name: operation.name
  properties: {
    displayName: '${operation.method} ${operation.urlTemplate}'
    method: operation.method
    urlTemplate: operation.urlTemplate
  }
}]

// Bicep multi-line strings take no interpolation, hence the placeholder replaced below.
var analyticsOriginElements = join(map(analyticsBrowserOrigins, origin => '        <origin>${origin}</origin>'), '\n')

// CORS only: the shared header comes from API scope through <base />.
var analyticsBearerCorsPolicy = replace('''<policies>
  <inbound>
    <base />
    <cors allow-credentials="false">
      <allowed-origins>
__ORIGINS__
      </allowed-origins>
      <allowed-methods>
        <method>GET</method>
        <method>POST</method>
        <method>PUT</method>
        <method>DELETE</method>
        <method>OPTIONS</method>
      </allowed-methods>
      <allowed-headers>
        <header>Authorization</header>
        <header>Content-Type</header>
      </allowed-headers>
    </cors>
  </inbound>
  <backend><base /></backend>
  <outbound><base /></outbound>
  <on-error><base /></on-error>
</policies>''', '__ORIGINS__', analyticsOriginElements)

resource analyticsBearerOperationPolicies 'Microsoft.ApiManagement/service/apis/operations/policies@2024-05-01' = [for (operation, index) in analyticsBearerOperations: if (analyticsDeployed && !empty(analyticsBrowserOrigins)) {
  parent: analyticsBearerOperationResources[index]
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: analyticsBearerCorsPolicy
  }
}]

resource analyticsApiPolicy 'Microsoft.ApiManagement/service/apis/policies@2024-05-01' = if (analyticsDeployed) {
  parent: analyticsApi
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: analyticsPolicyXml
  }
  dependsOn: [
    analyticsSharedHeader
  ]
}

// No OPTIONS operation: one would replace APIM's own preflight. 100 KiB is validate-content's ceiling.
// ponytail: no throttle (Consumption lacks rate-limit-by-key); per-IP limits need Basic v2.
resource analyticsEventsPolicy 'Microsoft.ApiManagement/service/apis/operations/policies@2024-05-01' = if (analyticsDeployed) {
  parent: analyticsEventsOperation
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: '''<policies>
  <inbound>
    <base />
    <cors allow-credentials="false">
      <allowed-origins>
        <origin>*</origin>
      </allowed-origins>
      <allowed-methods>
        <method>POST</method>
      </allowed-methods>
      <allowed-headers>
        <header>*</header>
      </allowed-headers>
    </cors>
    <validate-content unspecified-content-type-action="ignore" max-size="102400" size-exceeded-action="prevent" />
  </inbound>
  <backend><base /></backend>
  <outbound><base /></outbound>
  <on-error><base /></on-error>
</policies>'''
  }
}

// A revocable key per consumer makes each audit write attributable.
resource analyticsMachineApi 'Microsoft.ApiManagement/service/apis@2024-05-01' = if (analyticsDeployed) {
  parent: apim
  name: analyticsMachineApiName
  properties: {
    displayName: 'EPIC Analytics (machine)'
    path: 'analytics-machine'
    protocols: [
      'https'
    ]
    serviceUrl: analyticsBackendUrl
    subscriptionRequired: true
  }
}

resource analyticsAuditOperation 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = if (analyticsDeployed) {
  parent: analyticsMachineApi
  name: 'audit'
  properties: {
    displayName: 'POST /audit'
    method: 'POST'
    urlTemplate: '/audit'
  }
}

resource analyticsMachineApiPolicy 'Microsoft.ApiManagement/service/apis/policies@2024-05-01' = if (analyticsDeployed) {
  parent: analyticsMachineApi
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: analyticsMachinePolicyXml
  }
  dependsOn: [
    analyticsSharedHeader
    analyticsAuditHeader
  ]
}

resource analyticsMachineProduct 'Microsoft.ApiManagement/service/products@2024-05-01' = if (analyticsDeployed) {
  parent: apim
  name: 'analytics-machine'
  properties: {
    displayName: 'analytics-machine'
    description: 'Server-to-server writers of EPIC staff audit rows.'
    subscriptionRequired: true
    approvalRequired: false
    state: 'published'
  }
}

resource analyticsMachineProductApi 'Microsoft.ApiManagement/service/products/apis@2024-05-01' = if (analyticsDeployed) {
  parent: analyticsMachineProduct
  name: analyticsMachineApiName
  dependsOn: [
    analyticsMachineApi
  ]
}

resource analyticsMachineProductPolicy 'Microsoft.ApiManagement/service/products/policies@2024-05-01' = if (analyticsDeployed) {
  parent: analyticsMachineProduct
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: machineRateLimitPolicy
  }
}

// Servers only: the dashboard UI reads through the keyless API with its bearer.
var analyticsMachineConsumers = [
  'eagle-api'
]

resource analyticsMachineSubscriptions 'Microsoft.ApiManagement/service/subscriptions@2024-05-01' = [for consumer in analyticsMachineConsumers: if (analyticsDeployed) {
  parent: apim
  name: 'analytics-${consumer}'
  properties: {
    displayName: 'analytics-${consumer}'
    scope: analyticsMachineProduct.id
    state: 'active'
  }
}]

// Client copies of these headers are deleted first. src/utils/caller-ip.js trusts X-Client-Ip only
// with the gateway secret. No <base/>: the global scope has no parent and APIM rejects it.
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
  <backend><forward-request buffer-response="false" /></backend>
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
