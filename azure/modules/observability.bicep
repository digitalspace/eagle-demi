// Azure Monitor — the destination for every log line DEMI writes.
//
// Before this template existed the API had nowhere to log to. `host.json` configured Application
// Insights sampling against an Application Insights resource that was never created, and the only
// workspace in the resource group was a portal-created orphan (`workspace-c4b0a8devrgYb8e`) that
// held zero rows. Errors were visible in the live log stream and nowhere else, which means they
// were visible only while somebody happened to be watching.
//
// Application Insights is workspace-based and pinned to the same region as its workspace: it
// cannot function without Log Analytics, so splitting the two across regions would double the
// blast radius of a regional outage for no benefit.

@description('Location for the workspace and Application Insights component')
param location string = resourceGroup().location

@description('Environment name (e.g. dev, test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

var isProd = environmentName == 'prod'
var workspaceName = 'demi-logs-${environmentName}'
var appInsightsName = 'demi-insights-${environmentName}'

// Ingestion and retention are what Azure Monitor actually bills for, not query volume, so both
// are capped rather than left at their defaults. `dailyQuotaGb` stops collection for the rest of
// the UTC day once the cap is hit — a blunt backstop against a runaway log loop, not a tuning knob.
//
// The numbers are sized against the consumption budget in cost-budget.bicep, which is scope-wide
// and so already counts this workspace's spend: at roughly $2.76/GB, a sustained 1 GB/day would be
// ~$83/month and would eat that $100 ceiling on its own. Real DEMI log volume is orders of
// magnitude below these caps — they only bind when something has gone wrong, which is the point.
// Revisit after a week of real traffic.
var retentionDays = isProd ? 90 : 30
// Bicep has no float literal, hence json(): a bare 0.5 will not parse.
var dailyQuotaGb = isProd ? json('2') : json('0.5')

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: retentionDays
    workspaceCapping: {
      dailyQuotaGb: dailyQuotaGb
    }
    features: {
      // Read access follows the monitored resource rather than the workspace, so someone with
      // Reader on the app can see the app's logs without being granted the whole workspace.
      enableLogAccessUsingOnlyResourcePermissions: true
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    IngestionMode: 'LogAnalytics'
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

@description('Connection string the apps use to reach Application Insights')
output connectionString string = appInsights.properties.ConnectionString

@description('Resource ID of the Log Analytics workspace backing Application Insights')
output workspaceId string = workspace.id

@description('Name of the Log Analytics workspace, for KQL queries')
output workspaceName string = workspace.name
