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

@description('Principal id of the API identity. Granted Log Analytics Reader so the admin panel can read request health back through the API.')
param apiPrincipalId string

@description('Alert when the nightly reconcile reports drift. Off by default — an environment that does not set RECONCILE_SCHEDULE never writes the line this rule reads, and a rule that can only ever be silent is one more thing to keep.')
param deployReconcileDriftAlert bool = false

@description('Who to tell when ingestion approaches the daily cap. Also reused by audit-logs.bicep, which cannot own the action group itself: main.bicep deploys this module first, so a shared group has to live on this side of the dependency.')
param contactEmails array = [
  'Daniel.T.Truong@gov.bc.ca'
]

var isProd = environmentName == 'prod'
var workspaceName = 'demi-logs-${environmentName}'
var appInsightsName = 'demi-insights-${environmentName}'

// Ingestion and retention are what Azure Monitor actually bills for, not query volume, so both
// are capped rather than left at their defaults. `dailyQuotaGb` stops collection for the rest of
// the day once the cap is hit — a blunt backstop against a runaway log loop, not a tuning knob.
// The reset hour is the workspace's own, set when it was created, NOT midnight UTC.
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

// Log Analytics Reader. Read-only, and narrower than it looks: the app already WRITES here
// through Application Insights — this only lets it query AppRequests back (src/azure/monitor.js).
// A new assignment takes minutes to be honoured — retry a 403, do not re-grant.
var logAnalyticsReaderRoleId = '73c42c96-874c-492b-b04d-ab87d138a893'

resource appLogsReaderAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: workspace
  name: guid(workspace.id, apiPrincipalId, logAnalyticsReaderRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', logAnalyticsReaderRoleId)
    principalId: apiPrincipalId
    principalType: 'ServicePrincipal'
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

// The cap is a backstop with a nasty second effect: when `dailyQuotaGb` is reached, collection
// stops for the rest of the day — and that silences the audit-drop alert in audit-logs.bicep
// too, because that alert queries AppTraces in this workspace. A cap that disables the alarm is
// worse than no cap, so the approach to it has to be visible BEFORE it lands.
//
// This matters more now that the adapter emits 'finish' and every request produces an access-log
// line: log volume went from startup-and-errors to one line per request.
var dailyQuotaMb = isProd ? 2048 : 512
// 80%. Integer arithmetic on purpose — Bicep has no float literals, and a percentage does not
// need one.
var warnAtMb = dailyQuotaMb * 8 / 10

resource alertGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'demi-alerts-${environmentName}'
  location: 'global'
  tags: tags
  properties: {
    // Max 12 characters; it is the sender label on the notification.
    groupShortName: 'demialerts'
    enabled: true
    emailReceivers: [for (email, i) in contactEmails: {
      name: 'email${i}'
      emailAddress: email
      useCommonAlertSchema: true
    }]
  }
}

resource quotaAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = {
  name: 'demi-logs-quota-${environmentName}'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'DEMI log ingestion approaching the daily cap'
    description: 'Billable ingestion over the last 24h passed 80% of dailyQuotaGb. At 100% the workspace stops collecting until its next daily reset, which also takes the audit-drop alert down.'
    severity: 2
    enabled: true
    scopes: [ workspace.id ]
    evaluationFrequency: 'PT1H'
    // A rolling 24 hours, not the workspace's own quota day. The rule's window is the only
    // time filter that applies — adding `startofday()` to the query would INTERSECT with the window
    // rather than widen it, and a one-hour window would then measure one hour of ingest against a
    // daily quota. Rolling is the honest approximation; it warns early rather than late.
    windowSize: 'P1D'
    criteria: {
      allOf: [
        {
          query: 'Usage | where IsBillable | summarize IngestedMb = sum(Quantity) | where IngestedMb > ${warnAtMb}'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: [ alertGroup.id ]
    }
  }
}

// Drift between Eagle and DEMI, caught nightly. eagle-api hard-deletes with no tombstone, so the
// push cannot tell DEMI a row is gone — this rule is the only thing that notices, and it notices
// only because src/scripts/reconcile-eagle.js writes one machine-readable line per run.
//
// The line is `[reconcile] projects: … documents: … drift=N`, and `drift=0` is clean. Nothing
// alerts when the run does not happen at all: a nightly job that stops writing is a silent alert,
// which is the accepted ceiling here rather than a second rule counting absences.
resource reconcileDriftAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (deployReconcileDriftAlert) {
  name: 'demi-reconcile-drift-${environmentName}'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'DEMI reconcile reports Eagle drift'
    description: 'The nightly reconcile found rows Eagle publishes and DEMI does not, or DEMI rows gone from Eagle. Report-only: nothing was changed. Run src/scripts/reconcile-eagle.js --json for the ids.'
    // Warning, not error: drift is a mirror that has fallen behind, not a broken service, and the
    // report changes nothing on its own.
    severity: 2
    enabled: true
    scopes: [ workspace.id ]
    evaluationFrequency: 'PT1H'
    // A day, because the run is nightly — a shorter window would look at hours in which no line
    // was ever written and evaluate to nothing 23 times out of 24. Re-alerting hourly on the same
    // line is what `autoMitigate` is for.
    windowSize: 'P1D'
    criteria: {
      allOf: [
        {
          // `AppTraces` (workspace-based App Insights has no `traces` table) and `contains` (`has`
          // tokenises on brackets), both as in audit-logs.bicep. Every night writes this line, so
          // the count comes from `drift=` in the message rather than from the number of rows.
          query: 'AppTraces | where Message contains "[reconcile] projects" | extend drift = toint(extract("drift=([0-9]+)", 1, Message)) | where drift > 0'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: [ alertGroup.id ]
    }
  }
}

@description('Connection string the apps use to reach Application Insights')
output connectionString string = appInsights.properties.ConnectionString

@description('Action group shared with audit-logs.bicep, which deploys after this module')
output actionGroupId string = alertGroup.id

@description('Application Insights resource ID, for availability.bicep to link its web test to')
output appInsightsId string = appInsights.id

@description('Resource ID of the Log Analytics workspace backing Application Insights')
output workspaceId string = workspace.id

@description('Name of the Log Analytics workspace, for KQL queries')
output workspaceName string = workspace.name

@description('Workspace GUID, which is what the Log Analytics query API keys on — not the resource id')
output workspaceCustomerId string = workspace.properties.customerId
