// Azure App Service Module for DEMI Angular Frontend UI
@description('Location for Azure Web App resources')
param location string = resourceGroup().location

@description('Environment name (e.g. dev, test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

var frontendAppName = 'demi-frontend-${environmentName}'
var frontendAppPlanName = 'demi-frontend-plan-${environmentName}'

// App Service Plan for Frontend UI (Basic B1 Linux)
resource frontendAppServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: frontendAppPlanName
  location: location
  tags: tags
  sku: {
    name: 'B1'
    tier: 'Basic'
  }
  properties: {
    reserved: true // Linux worker
  }
}

// Azure Web App (Angular SPA Frontend Served via PM2)
resource frontendWebApp 'Microsoft.Web/sites@2023-12-01' = {
  name: frontendAppName
  location: location
  tags: tags
  kind: 'app,linux'
  properties: {
    serverFarmId: frontendAppServicePlan.id
    siteConfig: {
      linuxFxVersion: 'NODE|20-lts'
      appCommandLine: 'npx pm2 serve /home/site/wwwroot --no-daemon --spa'
      appSettings: [
        {
          name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
          value: 'false'
        }
        {
          name: 'WEBSITE_HTTPLOGGING_RETENTION_DAYS'
          value: '3'
        }
      ]
      cors: {
        allowedOrigins: [
          'https://portal.azure.com'
          '*'
        ]
      }
    }
  }
}

output frontendWebAppName string = frontendWebApp.name
output frontendWebAppHostName string = frontendWebApp.properties.defaultHostName
