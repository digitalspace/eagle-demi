// Azure App Service (Linux) for DEMI Angular Frontend in canadacentral
@description('Location for the App Service resource (Default: canadacentral)')
param location string = 'canadacentral'

@description('Environment name (e.g. dev, test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

@description('App Service Plan Name')
param appServicePlanName string = 'demi-frontend-plan-${environmentName}'

@description('App Service Web App Name')
param appName string = 'demi-frontend-${environmentName}'

// App Service Plan (Free F1 or Basic B1 tier in canadacentral)
resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: appServicePlanName
  location: location
  tags: tags
  sku: {
    name: 'F1' // Free tier
    tier: 'Free'
  }
  kind: 'linux'
  properties: {
    reserved: true // Required for Linux
  }
}

// Web App for Angular SPA
resource webApp 'Microsoft.Web/sites@2023-12-01' = {
  name: appName
  location: location
  tags: tags
  properties: {
    serverFarmId: appServicePlan.id
    siteConfig: {
      linuxFxVersion: 'NODE|20-lts'
      appCommandLine: 'npx pm2 serve /home/site/wwwroot --no-daemon --spa'
    }
    httpsOnly: true
  }
}

output staticWebAppName string = webApp.name
output staticWebAppDefaultHostName string = webApp.properties.defaultHostName
