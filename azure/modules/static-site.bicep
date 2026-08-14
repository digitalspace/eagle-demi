// Storage static website — the origin for the DEMI Angular frontend.
//
// Replaces `demi-frontend-<env>` (Linux App Service + a dedicated B1 plan running
// `npx pm2 serve --spa`). The bundle is static files; the plan was the only compute it ever paid
// for, and a Node worker that serves them is a worker that can also fall over.
//
// PUBLIC NETWORK ACCESS STAYS ON, and that is not the usual `Deny-PublicPaaSEndpoints` collision
// that forced AI Search and Foundry behind private endpoints. Two reasons it holds here: the $web
// endpoint is the ORIGIN for the Front Door profile (which lives in eagle-search, not in this
// template), and AFD Standard cannot reach an origin over Private Link — that is a Premium
// feature. Checked against the live subscription on 2026-08-14: `demistgtestvymaysch2agdq` and
// `eaglextrtestvymaysch2agd` both sit in this resource group with `defaultAction: Allow`, so the
// policy set that denies public PaaS endpoints does not extend to storage accounts.
//
// WHAT THIS MODULE CANNOT DO IS TURN STATIC WEBSITE HOSTING ON. `staticWebsite` is a data-plane
// setting on the Blob service and the ARM type has no property for it — bicep rejects it with
// BCP037, listing the permissible properties (cors, defaultServiceVersion, deleteRetentionPolicy,
// …) and staticWebsite is not among them. Writing it anyway compiles with a warning and is then
// dropped by ARM, which is worse than not writing it: the template would claim a setting it never
// applies. So `scripts/deploy-azure.sh frontend` runs it as its first step, on every deploy —
// idempotent, so re-applying the same values is a no-op:
//
//   az storage blob service-properties update --account-name <name> --auth-mode login \
//     --static-website --index-document index.html --404-document index.html
//
// Both documents are index.html because this is an SPA with client-side routing: a deep link has
// to return the app shell, not an error page.
//
// That call is a SERVICE-PROPERTIES write, which the Storage Blob Data Contributor assignment
// below does NOT cover — that role carries no `Microsoft.Storage/storageAccounts/blobServices/
// write`. Whoever runs the deploy also needs Storage Account Contributor on this account (or a
// custom role with that one action), otherwise the deploy stops on a 403 at step 1.
//
// RESPONSE HEADERS AND AUTH ARE NOT AVAILABLE HERE EITHER. $web serves blobs and nothing else, so
// the security headers the old Node server set (HSTS, CSP, X-Frame-Options, Referrer-Policy,
// Permissions-Policy) come from the Front Door rule set instead. Cache-Control is the exception:
// it is a blob property, so `scripts/deploy-azure.sh` sets it per file at upload time.

@description('Location for the storage account')
param location string = resourceGroup().location

@description('Environment name (e.g. dev, test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

@description('Principal id that publishes the bundle — the CI identity (demi-cicd-<env>). Empty grants nobody, and `az storage blob upload-batch --auth-mode login` then fails with 403.')
param uploaderPrincipalId string = ''

// Storage account names are 3-24 chars, lowercase alphanumeric only.
var storageAccountName = take('demiweb${environmentName}${uniqueString(resourceGroup().id)}', 24)

// Storage Blob Data Contributor — write blobs. The control plane cannot grant data-plane access,
// so this has to be a role assignment rather than a Website Contributor scope like the App Service
// deploy used.
var blobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

// Storage Account Contributor — the CONTROL plane, needed for exactly one thing: turning on static
// website hosting. `staticWebsite` lives on blobServices, not on the account, so ARM cannot set it
// and the deploy script calls `az storage blob service-properties update --static-website`. That is
// a `Microsoft.Storage/storageAccounts/blobServices/write`, which Storage Blob Data Contributor
// (data plane only) does not carry. Scoped to this one account, and safe to hand to CI only because
// `allowSharedKeyAccess: false` below makes the listKeys this role also grants return nothing usable.
var storageAccountContributorRoleId = '17d1049b-9a84-46fb-8f53-869881c3d3ab'

resource staticSite 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  tags: tags
  sku: {
    // LRS: the contents are a build artefact reproducible from the repo in a couple of minutes.
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    // No anonymous CONTAINER access. The static website endpoint is served anonymously regardless
    // — that is a property of the $web endpoint, not of blob public access — so this closes the
    // blob endpoint without closing the site.
    allowBlobPublicAccess: false
    // Entra only. Every writer here authenticates with `--auth-mode login` (CI via OIDC), so the
    // account keys are dead weight — and disabling them is what makes it acceptable to give CI the
    // Storage Account Contributor role above, since listKeys then returns credentials that cannot
    // authenticate. Also satisfies the landing-zone guardrail `deny-storage-shared-key`, which is
    // assigned as DoNotEnforce today but is the direction the platform team is heading.
    allowSharedKeyAccess: false
  }
}

resource uploaderBlobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(uploaderPrincipalId)) {
  scope: staticSite
  name: guid(staticSite.id, uploaderPrincipalId, blobDataContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions', blobDataContributorRoleId
    )
    principalId: uploaderPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource uploaderAccountContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(uploaderPrincipalId)) {
  scope: staticSite
  name: guid(staticSite.id, uploaderPrincipalId, storageAccountContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions', storageAccountContributorRoleId
    )
    principalId: uploaderPrincipalId
    principalType: 'ServicePrincipal'
  }
}

output storageAccountName string = staticSite.name
// Hostname only: no scheme, no trailing slash, because that is the shape Front Door wants for an
// origin. `primaryEndpoints.web` is 'https://<account>.z9.web.core.windows.net/'; a hostname
// contains no '/', so stripping every slash after the scheme is safe.
output staticSiteHostName string = replace(replace(staticSite.properties.primaryEndpoints.web, 'https://', ''), '/', '')
