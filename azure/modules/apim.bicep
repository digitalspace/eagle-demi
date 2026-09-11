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

@description('Vault holding the gateway secret and the two analytics header values. The APIM system identity is granted read on it.')
param keyVaultName string

@description('Name of the shared gateway secret in that vault.')
param gatewaySecretName string = 'apim-gateway-secret'

// eagle-analytics rides this gateway rather than paying a second Consumption instance's fixed cost.
// Its Function App lives in another repository, so its host name is a parameter here and is READ
// FROM that deployment's `apiHostName` output — never composed, the way frontendHostNames is not.
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

// All three, not just the URL: the Function refuses every request that arrives without the shared
// header and every /audit write without the audit one, so publishing the API on a header the vault
// cannot supply would deploy a gateway that 502s what it forwards.
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
    // Live state on both instances, and off is where we want it: the legacy portal is the
    // deprecated one and nothing here uses it. Unmodelled, every apply proposes turning it back on.
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
// fail it closed halfway through a run. Shared by both machine products, so the two ceilings cannot
// drift apart.
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

// ── eagle-analytics ─────────────────────────────────────────────────────────────────────────────
//
// TWO APIs again, for the reason at the top of this file: a key presented to an API that does not
// require one resolves ambiguously, so anonymous and keyed callers get separate APIs. Which splits
// the paths — `/analytics/...` for everything a browser reaches (ingest, health, and the read routes
// the DEMI admin screens call with a Keycloak bearer), `/analytics-machine/audit` for the one route
// only servers call. The analytics app strips one leading `/analytics` and matches both the prefixed
// and the root-mounted form, so the backend sees the same route either way.
//
// Operations are named one at a time rather than wildcarded like demi-api above: this surface is a
// short fixed list owned by one repository, and naming each one keeps a route nobody declared off
// the gateway.

// Key Vault-backed, same as gateway-secret above. eagle-analytics deploys the other side of both
// headers, but the vault is the one copy either side reads, so APIM is no longer a second store and
// a rotation is a new secret version rather than a redeploy of two repositories.
//
// No `identityClientId`: the service above is SystemAssigned, and that is the identity APIM uses
// when the property is absent. `dependsOn` the role assignment because APIM resolves the secret
// while it creates the named value — without the read grant already in place that create fails.
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

// API scope, because eagle-analytics puts its apimGuard on every route but /health, reads included:
// its Function host answers on a public hostname of its own, and a route reachable without this
// header is a route reachable without the gateway. /audit demands a second credential on top, and
// /query* and /dashboards* add the staff JWT — this header is the floor, not the whole check. Each
// name is deleted before it is set for the same reason the global policy deletes its three:
// anything a client sends under these names is attacker input dressed as the gateway.
//
// X-Analytics-Audit is deleted HERE AND STAMPED NOWHERE. This API is anonymous, so a client copy
// reaching the backend is the whole attack: /audit is only served behind the machine API below.
//
// Both names must equal APIM_SHARED_HEADER_NAME and AUDIT_SHARED_HEADER_NAME in eagle-analytics,
// whose defaults are these literals.
//
// Composed from fragments rather than written out twice: the machine policy differs by ONE stamp,
// and everything either API strips must not drift apart.
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

// The second credential, and only on the keyed API: /audit carries both guards, so the gateway has
// to prove itself twice.
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

// The read routes the DEMI admin screens call from a browser. Anonymous AT THE GATEWAY and not
// unauthenticated: each request carries a Keycloak bearer that the app verifies against its own role
// gate. A subscription key cannot guard these — a page cannot hold one secretly — so the key stays
// on /audit, which only servers call.
//
// `/dashboards` and `/dashboards/*` are separate operations because an APIM wildcard matches a
// segment that is there, not a missing one — one entry alone would 404 either the list or the items.
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

// Named origins, not `*`: `*` would be the wrong answer for a request that carries a bearer, and
// these are the same hostnames CORS_ORIGIN admits (main.bicep builds the list from
// frontendHostNames, so a deploy-time AFD hash is never written twice).
//
// One indented <origin> element per entry. Bicep multi-line strings take no interpolation, hence
// this and the header placeholder below.
var analyticsOriginElements = join(map(analyticsBrowserOrigins, origin => '        <origin>${origin}</origin>'), '\n')

// CORS only. The shared header is stamped at API scope above, which every operation inherits
// through <base />, so repeating it here would only set the same value twice.
//
// Authorization is forwarded exactly as it arrives: nothing in this file rewrites or removes it, and
// the app is what verifies the token.
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

// Ingest only. CORS sits on this one operation because it is the only one a web page posts to, and
// APIM answers the preflight from this scope itself — declaring an OPTIONS operation would REPLACE
// that built-in handling, which is why there is none.
//
// NO per-caller throttle here, and that is a tier limit rather than a choice: `rate-limit-by-key`
// and `quota-by-key` do not exist in Consumption, and plain `rate-limit` counts per subscription,
// which an anonymous product has none of. What guards the uncapped workspace instead is the ingest
// Function's own per-session cap plus the budget forecast alert.
// ponytail: public ingest with no gateway rate limit. Per-IP limiting needs Basic v2 or a counter
// of our own in Table Storage — revisit if the drop alert or the budget alert ever fires.
//
// 100 KiB, not the 256 KB a 50-event batch could reach: that is the gateway's own runtime ceiling
// for validate-content, and a larger number would read as enforced without being it.
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

// Keyed path, and one route only: staff audit rows in, from other EPIC services. Reached as
// /analytics-machine/audit with Ocp-Apim-Subscription-Key. The read routes live on the anonymous API
// above because a browser cannot hold a key; a server writing audit rows can, and a revocable key
// per consumer is what makes that write attributable.
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

// One subscription per consumer, rotatable alone, keys read with `az apim subscription list-keys`.
// Servers only: the dashboard UI needs no entry here, since its read routes sit on the anonymous API
// and are authorised by the bearer it already holds.
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
