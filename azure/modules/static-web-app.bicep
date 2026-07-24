// Azure Static Web App for DEMI Angular Frontend
@description('Location for the Static Web App resource (Default: centralus for SWA control plane)')
param location string = 'centralus'

@description('Environment name (e.g. dev, test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

@description('Static Web App Name')
param appName string = 'demi-frontend-${environmentName}'

// Free Tier Azure Static Web App (Global CDN distribution)
resource staticWebApp 'Microsoft.Web/staticSites@2023-12-01' = {
  name: appName
  location: location
  tags: tags
  sku: {
    name: 'Free'
    tier: 'Free'
  }
  properties: {
    allowConfigFileUpdates: true
    stagingEnvironmentPolicy: 'Enabled'
  }
}

output staticWebAppName string = staticWebApp.name
output staticWebAppDefaultHostName string = staticWebApp.properties.defaultHostname

