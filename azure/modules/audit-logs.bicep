// Audit and usage-analytics store.
//
// WHY A SECOND WORKSPACE. `observability.bicep` already builds `demi-logs-<env>`, and audit rows
// could physically live there. They must not, for one reason: that workspace carries
// `workspaceCapping.dailyQuotaGb` (0.5 in test, 2 in prod), which STOPS COLLECTION for the rest of
// the UTC day once hit. That cap is the right backstop for a runaway log loop and the wrong
// behaviour for an audit trail — a chatty error path would silently take the compliance record
// down with it. Removing the cap to make room trades one safety for the other; a second,
// uncapped workspace keeps both. It also separates read access: querying the audit record is a
// different grant from reading application logs.
//
// WHY TWO TABLES, NOT ONE. Audit is small, identity-bearing, and must never be deleted (7 years).
// Analytics is large, must be identity-MINIMIZED, and must be expirable on request (13 months).
// Those two requirements collide in the same rows, so they get separate tables — and separate
// table plans, which is also where the cost difference lives.
//
//   DemiAudit_CL        Analytics plan  — interactive queries cost nothing, so the UI can hammer it
//   DemiEvents_CL       Auxiliary plan  — ~$0.15/GB ingest, queries billed on GB scanned
//   DemiEventsHourly_CL Analytics plan  — created BY the summary rule below, not declared here
//
// The summary rule is what makes the cheap tier usable: dashboards read the small hourly rollup
// for free instead of scanning raw events.

@description('Location for the workspace and data collection rule. Both must share a region.')
param location string = resourceGroup().location

@description('Environment name (e.g. dev, test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

@description('Principal ID of the identity the API runs as. Granted publish-only rights on the DCR.')
param apiPrincipalId string

@description('Resource ID of the APPLICATION logs workspace (observability.bicep). The audit writer reports its own failures to the app logger, so the alert below queries that workspace, not this one.')
param appLogsWorkspaceId string = ''

@description('Action group to notify when the audit pipeline drops rows. Owned by observability.bicep, which main.bicep deploys first — one group for both alerts, and the only dependency direction that does not create a module cycle. Empty skips the alert.')
param alertActionGroupId string = ''

var workspaceName = 'demi-audit-${environmentName}'
var dcrName = 'demi-audit-dcr-${environmentName}'
var auditTableName = 'DemiAudit_CL'
var eventsTableName = 'DemiEvents_CL'
var summaryTableName = 'DemiEventsHourly_CL'

// Retention. 2556 days is seven years, the horizon audit records are kept against; the first 730
// (the platform maximum for interactive retention) stay queryable, the rest sit in long-term
// retention and come back through a search job. 400 days on events is thirteen months — enough to
// compare a month against the same month last year, and no longer.
//
// 2556 and NOT 2555, which is what 7 x 365 gives and what the API rejects: past two years, total
// retention must be a whole number of years drawn from a fixed list — 1095, 1460, 1826, 2191, 2556,
// 2922, 3288, 3653, 4018, 4383. Anything else fails the deployment with InvalidParameter.
var auditInteractiveDays = 730
var auditTotalDays = 2556
var eventsTotalDays = 400

// Column sets are declared once and used twice: once as the table schema, once as the DCR stream
// declaration. They must agree, and a single source is the only way to keep them agreeing.
//
// Fixed columns exist for anything ever filtered or grouped on. Everything else goes in `Detail`,
// which is dynamic — so a new event type is a new value, not a schema change.
var auditColumns = [
  { name: 'TimeGenerated', type: 'datetime' }
  { name: 'EventId', type: 'string' }
  { name: 'Action', type: 'string' }
  { name: 'Outcome', type: 'string' }
  // Both identifiers, deliberately. `sub` is stable across a rename and is what joins to Keycloak;
  // ActorName is what a human reads without going and asking Keycloak who a UUID is. An audit trail
  // that needs a second system online to answer "who did this" is worse than one that does not.
  { name: 'ActorId', type: 'string' }
  { name: 'ActorName', type: 'string' }
  { name: 'ActorType', type: 'string' }
  { name: 'ActorRoles', type: 'string' }
  { name: 'SourceIp', type: 'string' }
  { name: 'TargetType', type: 'string' }
  { name: 'TargetId', type: 'string' }
  { name: 'ProjectId', type: 'string' }
  { name: 'CorrelationId', type: 'string' }
  { name: 'Env', type: 'string' }
  { name: 'Detail', type: 'dynamic' }
]

// Anonymous ONLY for anonymous callers. No IP ever reaches this table, and for public traffic the
// rotating `AnonId` hash is the only identifier there is — so that traffic stops being linkable
// after 24 hours by construction, which is what lets a table with no cheap targeted delete keep
// rows for 400 days.
//
// A SIGNED-IN caller is a different question and gets a different answer: staff activity is
// attributable, because "which of our people searched for this" is precisely what an investigator
// will ask, and a table that cannot answer it is not worth keeping. Those rows carry the Keycloak
// identity in ActorId/ActorName; public rows leave them empty.
var eventsColumns = [
  { name: 'TimeGenerated', type: 'datetime' }
  { name: 'EventName', type: 'string' }
  { name: 'ActorId', type: 'string' }
  { name: 'ActorName', type: 'string' }
  { name: 'ActorType', type: 'string' }
  { name: 'AnonId', type: 'string' }
  { name: 'SessionId', type: 'string' }
  { name: 'ProjectId', type: 'string' }
  { name: 'DocumentId', type: 'string' }
  { name: 'SearchTerm', type: 'string' }
  { name: 'ResultCount', type: 'int' }
  { name: 'DeviceType', type: 'string' }
  { name: 'Country', type: 'string' }
  { name: 'Referrer', type: 'string' }
  { name: 'Env', type: 'string' }
  { name: 'Detail', type: 'dynamic' }
]

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    // Workspace-level default only. Both tables below set their own retention, and per-table
    // settings win. Deliberately NO workspaceCapping — see the header.
    retentionInDays: 30
    features: {
      // FALSE here, and true in observability.bicep, on purpose. There the point is that someone
      // with Reader on the app can read the app's logs. Here the audit record is not an attribute
      // of any monitored resource, and read access should be a deliberate grant on this workspace.
      enableLogAccessUsingOnlyResourcePermissions: false
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

// API version 2025-07-01 is load-bearing: `plan: 'Auxiliary'` does not exist before it, and
// 2023-09-01 accepts only 'Analytics' and 'Basic'.
resource auditTable 'Microsoft.OperationalInsights/workspaces/tables@2025-07-01' = {
  parent: workspace
  name: auditTableName
  properties: {
    plan: 'Analytics'
    retentionInDays: auditInteractiveDays
    totalRetentionInDays: auditTotalDays
    schema: {
      name: auditTableName
      columns: auditColumns
    }
  }
}

resource eventsTable 'Microsoft.OperationalInsights/workspaces/tables@2025-07-01' = {
  parent: workspace
  name: eventsTableName
  properties: {
    plan: 'Auxiliary'
    // NO retentionInDays. It is read-only on Auxiliary and Basic tables, and setting it is
    // rejected rather than ignored.
    totalRetentionInDays: eventsTotalDays
    schema: {
      name: eventsTableName
      columns: eventsColumns
    }
  }
}

// `kind: 'Direct'` is what lets the app POST straight to the rule's own ingestion endpoint. The
// alternative is a Data Collection Endpoint resource, which is only needed to put ingestion behind
// Private Link — and this landing zone's `Deny-PublicPaaSEndpoints` policy applies to PaaS
// accounts, not to the Microsoft-managed ingestion endpoint a Direct DCR exposes.
resource dcr 'Microsoft.Insights/dataCollectionRules@2023-03-11' = {
  name: dcrName
  location: location
  tags: tags
  kind: 'Direct'
  properties: {
    streamDeclarations: {
      'Custom-DemiAudit_CL': {
        columns: auditColumns
      }
      'Custom-DemiEvents_CL': {
        columns: eventsColumns
      }
    }
    destinations: {
      logAnalytics: [
        {
          workspaceResourceId: workspace.id
          name: 'demiAuditWorkspace'
        }
      ]
    }
    dataFlows: [
      {
        streams: [ 'Custom-DemiAudit_CL' ]
        destinations: [ 'demiAuditWorkspace' ]
        outputStream: 'Custom-${auditTableName}'
        // The IP mask lives HERE rather than in the app, so it cannot be bypassed by whatever
        // calls the ingestion endpoint. Keeps the first two octets — enough to tell "inside the
        // gov network" from "not" — and drops anything that is not dotted-quad (IPv6, 'unknown')
        // to 'redacted' rather than passing it through unmasked.
        //
        // `extract` is called twice instead of stashing a temp column: a transform's output
        // columns must match the destination table, and a leftover scratch column is one more
        // thing to strip.
        transformKql: 'source | extend SourceIp = iff(isempty(extract(@"^(\\d{1,3}\\.\\d{1,3})\\.", 1, SourceIp)), "redacted", strcat(extract(@"^(\\d{1,3}\\.\\d{1,3})\\.", 1, SourceIp), ".0.0"))'
      }
      {
        streams: [ 'Custom-DemiEvents_CL' ]
        destinations: [ 'demiAuditWorkspace' ]
        outputStream: 'Custom-${eventsTableName}'
        // Identity minimisation already happened in the app — there is no IP here to mask.
        transformKql: 'source'
      }
    ]
  }
  dependsOn: [
    auditTable
    eventsTable
  ]
}

// Monitoring Metrics Publisher. Publish-only: it grants the app the right to SEND data to this
// rule and no right to read anything back. The audit writer is not a reader.
var monitoringMetricsPublisherRoleId = '3913510d-42f4-4e42-8a64-420c390055eb'

resource publisherAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: dcr
  name: guid(dcr.id, apiPrincipalId, monitoringMetricsPublisherRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', monitoringMetricsPublisherRoleId)
    principalId: apiPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Log Analytics Reader, on the workspace rather than the DCR: the admin panel reads the audit
// trail back through the API, which queries with this same identity (src/azure/monitor.js).
// A new assignment takes minutes to be honoured — retry a 403, do not re-grant.
var logAnalyticsReaderRoleId = '73c42c96-874c-492b-b04d-ab87d138a893'

resource auditReaderAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: workspace
  name: guid(workspace.id, apiPrincipalId, logAnalyticsReaderRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', logAnalyticsReaderRoleId)
    principalId: apiPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// The rollup destination is declared rather than left to the summary rule.
//
// The rule creates the table on its first run if it is absent, but it creates it with the
// WORKSPACE default retention — 30 days, measured on the first staging deploy. A rollup that
// expires in a month cannot answer "this month against the same month last year", which is most of
// why it exists. Declaring it here fixes the retention; Azure Monitor adds any columns the query
// introduces to an existing table, so the rule still owns the schema in practice.
resource eventsHourlyTable 'Microsoft.OperationalInsights/workspaces/tables@2025-07-01' = {
  parent: workspace
  name: summaryTableName
  properties: {
    plan: 'Analytics'
    retentionInDays: auditInteractiveDays
    totalRetentionInDays: auditInteractiveDays
    schema: {
      name: summaryTableName
      columns: [
        { name: 'TimeGenerated', type: 'datetime' }
        { name: 'EventName', type: 'string' }
        { name: 'ActorType', type: 'string' }
        { name: 'ProjectId', type: 'string' }
        { name: 'Env', type: 'string' }
        // count() and dcount() are long; avg() is real. A type mismatch here breaks the rule's
        // write rather than the deployment, so they track the query below.
        { name: 'Events', type: 'long' }
        { name: 'Users', type: 'long' }
        { name: 'AvgResults', type: 'real' }
      ]
    }
  }
}

// Resource-log tables fed by the diagnostic settings in api-function-flex.bicep and cosmos-nosql.bicep.
//
// Declared for exactly the reason eventsHourlyTable above is: a table that arrives in this
// workspace on its own inherits the WORKSPACE default of 30 days, and an audit record that expires
// in a month is not one. These are Azure tables rather than custom ones, so they carry no `plan`
// and no `schema` — Azure owns both — and only retention is ours to set.
//
// 90/730 rather than the audit table's 730/2556: an investigation into who deployed or who altered
// a container is measured in weeks, and long-term retention costs a fraction of interactive.
//
// If a first deployment fails here because the table does not exist yet, let the diagnostic
// setting materialise it, run `az monitor log-analytics workspace table update` once, and this
// becomes idempotent.
resource appServiceAuditTable 'Microsoft.OperationalInsights/workspaces/tables@2025-07-01' = {
  parent: workspace
  name: 'AppServiceAuditLogs'
  properties: {
    retentionInDays: 90
    totalRetentionInDays: 730
  }
}

resource cosmosControlPlaneTable 'Microsoft.OperationalInsights/workspaces/tables@2025-07-01' = {
  parent: workspace
  name: 'CDBControlPlaneRequests'
  properties: {
    retentionInDays: 90
    totalRetentionInDays: 730
  }
}

//
// No time filter and no `bin(TimeGenerated, 1h)` in the query: `binSize` already defines the
// window, and the destination rows carry `_BinStartTime`. Adding either narrows the bin instead of
// grouping it.
resource eventsRollup 'Microsoft.OperationalInsights/workspaces/summaryLogs@2025-07-01' = {
  parent: workspace
  name: 'demi-events-hourly'
  properties: {
    ruleType: 'User'
    displayName: 'DEMI usage events, hourly'
    description: 'Hourly rollup of ${eventsTableName} so dashboards read a small Analytics table instead of scanning raw Auxiliary data.'
    ruleDefinition: {
      // Grouped by ActorType as well, so the rollup can answer "how much of this is staff and how
      // much is the public" — the first question anyone asks of usage data, and one the raw table
      // cannot be asked cheaply because Auxiliary queries bill on data scanned. It is also the only
      // way to see signed-in attribution at all: a direct query against an Auxiliary table returns
      // nothing, while the summary rule reads it server-side quite happily.
      query: '${eventsTableName} | summarize Events = count(), Users = dcount(AnonId), AvgResults = avg(ResultCount) by EventName, ActorType, ProjectId, Env'
      binSize: 60
      destinationTable: summaryTableName
      timeSelector: 'TimeGenerated'
    }
  }
  dependsOn: [
    eventsTable
    // Load-bearing, not tidiness. Without it the rule and its destination table deploy in
    // parallel, and a rule that reaches its first run before the table exists CREATES the
    // destination itself — at the workspace default of 30 days, which is the retention defect this
    // module already had once. That bug would come back on any fresh deploy, and only there.
    eventsHourlyTable
  ]
}

// AU-5, the other half of fire-and-forget. The writer never fails a request when ingestion is
// down; it drops the rows into the application logger instead. That is only a recovery path if
// somebody finds out it happened, so the drop is alerted on rather than left in a log nobody reads.
//
// The query runs against the APPLICATION workspace, not this one — by the time the writer is
// logging a drop, this workspace is precisely what it could not reach.
//
// KNOWN CEILING: the fallback lands in the capped workspace, so a sustained outage can dump enough
// payload to hit `dailyQuotaGb` and lose the tail of the very rows it was preserving. Bounded
// recovery beats none, and the alert is what makes the window short.
resource auditDropAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (!empty(appLogsWorkspaceId) && !empty(alertActionGroupId)) {
  name: 'demi-audit-drop-${environmentName}'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'DEMI audit rows dropped'
    description: 'The audit writer gave up on a batch after three attempts. Those rows exist only in the application log, and only for as long as its retention.'
    // Error, not warning: a gap in the audit trail is not a degraded feature.
    severity: 1
    enabled: true
    scopes: [ appLogsWorkspaceId ]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          // `AppTraces` is the workspace-based Application Insights table the winston lines land
          // in — not `traces`, which is the classic schema and does not exist here.
          //
          // `contains`, not `has`: `has` matches whole terms, and the tokeniser treats brackets as
          // separators, so the exact behaviour of `has "[Audit] dropped"` depends on how the term
          // sequence is split. At this volume the indexed-lookup advantage of `has` is worth
          // nothing, and an alert that silently never matches is worse than no alert — this one is
          // the entire reason fire-and-forget is defensible.
          query: 'AppTraces | where Message contains "[Audit] dropped"'
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
      actionGroups: [ alertActionGroupId ]
    }
  }
}

@description('Ingestion endpoint the app POSTs to. Empty until the Direct DCR finishes provisioning.')
output dcrEndpoint string = dcr.properties.endpoints.logsIngestion

@description('Immutable ID of the DCR — the path segment in the ingestion URL, not the resource name.')
output dcrImmutableId string = dcr.properties.immutableId

@description('Name of the audit workspace, for KQL queries and the future read endpoint')
output workspaceName string = workspace.name

@description('Resource ID of the audit workspace')
output workspaceId string = workspace.id

@description('GUID the query API addresses this workspace by — not the resource ID')
output workspaceCustomerId string = workspace.properties.customerId
