// Application Insights stays in its workspace's region: it cannot run without Log Analytics, so
// splitting regions only doubles the outage risk.

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

@description('Alert when a bulk download job fails. Off by default, like the drift alert: an environment with no BULK_DOWNLOADS_QUEUE never writes the line this rule reads.')
param deployBulkDownloadPoisonAlert bool = false

@description('Alert when the nightly Track teams sync still finds project drift. Off until Track pushes its writes: until then the nightly is the only writer of works and fires every night.')
param deployTrackDriftAlert bool = false

@description('Storage queue the chunk parent-field re-stamp worker triggers on. Gates the poison alert below directly rather than through its own bool: an environment with no queue name never writes the line the alert reads.')
param chunkRestampQueue string = ''

@description('Storage queue the sync-out worker triggers on. Gates its poison alert the same way chunkRestampQueue gates its own.')
param syncOutQueue string = ''

@description('SYNC_PROJECTS_SCHEDULE of the API. Gates the Track projects poll alert: empty means the timer never runs, and an absence alert on it would fire forever.')
param syncProjectsSchedule string = ''

@description('SYNC_TEAMS_SCHEDULE of the API. Gates the Track teams alert the same way.')
param syncTeamsSchedule string = ''

@description('Who to tell when ingestion approaches the daily cap. Also reused by audit-logs.bicep, which cannot own the action group itself: main.bicep deploys this module first, so a shared group has to live on this side of the dependency.')
param contactEmails array = [
  'Daniel.T.Truong@gov.bc.ca'
]

var isProd = environmentName == 'prod'
var workspaceName = 'demi-logs-${environmentName}'
var appInsightsName = 'demi-insights-${environmentName}'

// Caps sized against the cost-budget.bicep ceiling; they bind only on a runaway log loop. The
// daily quota resets at the workspace's own hour, not midnight UTC.
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
      // Reader on the app is enough to read its logs; no workspace grant needed.
      enableLogAccessUsingOnlyResourcePermissions: true
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

// Lets src/azure/monitor.js query AppRequests back. A new grant takes minutes to apply: retry a
// 403, do not re-grant.
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

// Hitting the daily cap stops collection, which also silences the audit-drop alert in
// audit-logs.bicep, so the approach to the cap must alert first.
var dailyQuotaMb = isProd ? 2048 : 512
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
    // Rolling 24 hours, not the quota day: a startofday() filter would intersect the window, not
    // widen it. Rolling warns early rather than late.
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

// eagle-api hard-deletes with no tombstone, so this rule is the only thing that sees a lost row.
// A run that never happens stays silent; that ceiling is accepted.
resource reconcileDriftAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (deployReconcileDriftAlert) {
  name: 'demi-reconcile-drift-${environmentName}'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'DEMI reconcile reports Eagle drift'
    description: 'The nightly reconcile found rows Eagle publishes and DEMI does not, or DEMI rows gone from Eagle. Report-only: nothing was changed. Run src/scripts/reconcile-eagle.js --json for the ids.'
    severity: 2
    enabled: true
    scopes: [ workspace.id ]
    evaluationFrequency: 'PT1H'
    // The run is nightly; a shorter window would mostly see no line at all.
    windowSize: 'P1D'
    criteria: {
      allOf: [
        {
          // Workspace App Insights has AppTraces, not traces; `has` tokenises on brackets, so
          // `contains`. Every night writes the line, so drift comes from `drift=`, not row count.
          query: 'AppTraces | where Message contains "[reconcile] projects" | extend drift = toint(extract("drift=([0-9]+)", 1, Message)), pending = toint(extract("parentFieldsPending=([0-9]+)", 1, Message)) | where drift > 0 or pending > 0'
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

// The worker logs this line on the last attempt only, so one line is one dead job. Reads the log
// because storage emits no per-queue length metric.
resource bulkDownloadPoisonAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (deployBulkDownloadPoisonAlert) {
  name: 'demi-bulk-download-failed-${environmentName}'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'DEMI bulk download job failed'
    description: 'A bulk download job failed after its retries. The requester sees status `failed`; the job row holds the error. See the Bulk-Download wiki page for the poison-queue runbook.'
    severity: 2
    enabled: true
    scopes: [ workspace.id ]
    evaluationFrequency: 'PT15M'
    // Same as the frequency, so one failure is not counted twice.
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: 'AppTraces | where Message contains "[bulk] job failed"'
          timeAggregation: 'Count'
          operator: 'GreaterThanOrEqual'
          threshold: 1
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

// Same shape as bulkDownloadPoisonAlert: src/jobs/restamp-chunks.js logs this line once, on the
// last attempt, so one line is one document with stale chunks.
resource chunkRestampPoisonAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (!empty(chunkRestampQueue)) {
  name: 'demi-chunk-restamp-failed-${environmentName}'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'DEMI chunk re-stamp job failed'
    description: 'A chunk parent-field re-stamp job failed after its retries. The document\'s chunks are stale; the repair is src/scripts/backfill-chunk-parent-fields.js --live --project <id>, which re-stamps that project and clears the pending flag on the documents it verifies.'
    severity: 2
    enabled: true
    scopes: [ workspace.id ]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: 'AppTraces | where Message contains "[chunk restamp] job failed"'
          timeAggregation: 'Count'
          operator: 'GreaterThanOrEqual'
          threshold: 1
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

// The worker moves the message to the poison queue itself, then logs the line once.
resource syncOutPoisonAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (!empty(syncOutQueue)) {
  name: 'demi-sync-out-failed-${environmentName}'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'DEMI sync-out job failed'
    description: 'A sync-out message failed after its retries, so Eagle did not get that comment period change. The worker moved the message to the `${syncOutQueue}-poison` queue before it wrote the line, and the line names the row.'
    severity: 2
    enabled: true
    scopes: [ workspace.id ]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: 'AppTraces | where Message contains "[sync-out] job failed"'
          timeAggregation: 'Count'
          operator: 'GreaterThanOrEqual'
          threshold: 1
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

// Sees the cause of an RU burn that cosmos-alerts.bicep sees only as cost. Five in an hour: one
// oversized document is noise, a retry loop writes these lines without pause.
resource chunkIngestFailuresAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = {
  name: 'demi-chunk-ingest-failures-${environmentName}'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'DEMI chunk ingest is failing repeatedly'
    description: 'Five or more `chunk write incomplete`, `chunk ingest rejected` or `Chunk ingest failed` lines in an hour. A retry loop on chunk writes spends Cosmos RU for as long as it runs: check the Cosmos RU alert and the documents named in the lines, and stop the push that keeps resending them.'
    severity: 2
    enabled: true
    scopes: [ workspace.id ]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT1H'
    criteria: {
      allOf: [
        {
          // `contains` is case-insensitive, so this also matches the capitalised `Chunk ingest failed`.
          query: 'AppTraces | where Message contains "chunk write incomplete" or Message contains "chunk ingest rejected" or Message contains "chunk ingest failed"'
          timeAggregation: 'Count'
          operator: 'GreaterThanOrEqual'
          threshold: 5
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

// Three in five minutes: one line is one bad request, a broken index or upstream writes them
// without pause.
resource searchFailuresAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = {
  name: 'demi-search-failures-${environmentName}'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'DEMI search is failing'
    description: 'Three or more search errors in five minutes, from either of two branches: `[search] … failed` and `[search/summary] … failed`, where the caller got a 502 or an empty summary, and `[ai-search] … retried without it`, where the live index could not answer a field, so the page was SERVED as a 200 with `meta.degraded` and is missing a column. Check the index against the deployed build first: GET /health/search-schema names a missing field. Runbook: docs/runbook-search-outage.md in the eagle-demi repo.'
    severity: 1
    enabled: true
    scopes: [ workspace.id ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          // Tags stay closed: `[search` alone would match the anonymous [search-schema] probe. The
          // summary route and the ai-search degrade both answer 200, so only this rule sees them.
          query: 'AppTraces | where (Message startswith "[search]" and Message contains "failed") or (Message startswith "[search/summary]" and Message contains "failed") or (Message contains "[ai-search]" and Message contains "retried without it") or (Message startswith "[demi-api search]" and Message contains "error")'
          timeAggregation: 'Count'
          operator: 'GreaterThanOrEqual'
          threshold: 3
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

// Still fires when the process dies before it can log. A ratio, since traffic swings 100x;
// `total >= 5` keeps one failure in an idle window from reading as 100%.
resource search5xxRatioAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = {
  name: 'demi-search-5xx-ratio-${environmentName}'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'DEMI search 5xx rate over 20%'
    description: 'More than a fifth of the search requests in the last five minutes answered 5xx, over at least five requests. Same runbook as demi-search-failures: docs/runbook-search-outage.md in the eagle-demi repo.'
    severity: 1
    enabled: true
    scopes: [ workspace.id ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          // One catch-all function serves every route, so only the Url path tells search apart.
          // ResultCode is a string; toint makes `>= 500` numeric.
          query: 'AppRequests | extend p = tostring(parse_url(Url).Path) | where p endswith "/search" or p endswith "/search/counts" or p endswith "/search/summary" | summarize total = count(), failed = countif(toint(ResultCode) >= 500) | where total >= 5 and todouble(failed) / total > 0.2'
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

// Also fires on silence: `summarize` without `by` yields one row on empty input. The window is
// one size above the query span so it never narrows it; `missing` and `failed` are KQL keywords.
resource trackProjectsPollAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (!empty(syncProjectsSchedule)) {
  name: 'demi-track-projects-poll-${environmentName}'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'DEMI Track project poll stalled or failing'
    description: 'In the last 20 minutes the Track project poll wrote no `[track-projects-poll] mode=live` line, or a line with failures above 0, or `run failed`. Track project edits are not reaching DEMI. Check the demi-api function app, then run src/scripts/sync-track-run.js by hand for the error.'
    severity: 2
    enabled: true
    scopes: [ workspace.id ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT30M'
    criteria: {
      allOf: [
        {
          query: '''
let span = 20m;
let poll = AppTraces | where TimeGenerated > ago(span) and Message startswith "[track-projects-poll]";
let absent = poll | where Message contains "mode=live" | summarize n = count() | where n == 0 | project problem = "no live poll line";
let failing = poll | extend failures = toint(extract("failures=([0-9]+)", 1, Message)) | where failures > 0 or Message contains "run failed" | summarize n = count() | where n > 0 | project problem = strcat(n, " failed poll line(s)");
union absent, failing
'''
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

// Same shape as trackProjectsPollAlert; 26 hours is one daily run plus slack for a late one.
resource trackTeamsAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (!empty(syncTeamsSchedule)) {
  name: 'demi-track-teams-${environmentName}'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'DEMI Track teams sync stalled or failing'
    description: 'In the last 26 hours the Track teams sync wrote no `[track-teams] mode=live` line, or a line with failures above 0, or `nightly run failed`. Project team roles, the Track project mirror or the assessment pass are not being updated. With ASSESSMENT_PASS on, a failed assessment pass adds to that failures count, and its own `[assessment-phases]` lines name the project. Check the demi-api function app, then run src/scripts/sync-track-teams.js (dry run) by hand for the error.'
    severity: 2
    enabled: true
    scopes: [ workspace.id ]
    evaluationFrequency: 'PT1H'
    windowSize: 'P2D'
    criteria: {
      allOf: [
        {
          query: '''
let span = 26h;
let teams = AppTraces | where TimeGenerated > ago(span) and Message startswith "[track-teams]";
let absent = teams | where Message contains "[track-teams] mode=live" | summarize n = count() | where n == 0 | project problem = "no live teams line";
let failing = teams | extend failures = toint(extract("failures=([0-9]+)", 1, Message)) | where failures > 0 or Message contains "nightly run failed" | summarize n = count() | where n > 0 | project problem = strcat(n, " failed teams line(s)");
union absent, failing
'''
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

// A Track push DEMI refused or could not apply. A lone retryable line stays quiet: Track sends a
// 5xx again once, so one id needs two such lines to mean the retry did not land.
resource trackPushAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = {
  name: 'demi-track-push-${environmentName}'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'DEMI Track push failed'
    description: 'In the last 30 minutes DEMI refused Track (`[demi-api] Track refused apim:`), found no registry row for the `track` subscription, wrote an error-level `[track-push]` line that is not retryable, or wrote 2 or more retryable lines for one project id. Retryable lines are `write failed` and `delete lost its etag race`; one alone is left to the retry Track sends. APIM 401, 429 and 504 write no app line and show only in the Track log. A registry row with no write role is refused by requireWrite with no log line, so it also shows only in the Track log. Check the demi-api function app; the nightly Track teams sync repairs a lost project write, but not a lost delete.'
    severity: 2
    enabled: true
    scopes: [ workspace.id ]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT30M'
    criteria: {
      allOf: [
        {
          // SeverityLevel 3 is winston `error`, mapped by the Azure Monitor log exporter. Info lines
          // share the prefix. The two refusal lines log at warn, so they are matched by their text.
          query: '''
let lines = AppTraces
| where (Message startswith "[track-push]" and SeverityLevel >= 3) or Message startswith "[demi-api] Track refused apim:" or Message startswith "[demi-api] APIM subscription 'track' has no registry row"
| extend retryable = Message startswith "[track-push] write failed id=" or Message startswith "[track-push] delete lost its etag race id=", projectId = extract("id=([^ ]+)", 1, Message);
let hard = lines | where not(retryable) | summarize n = count() | where n > 0 | project problem = strcat(n, " non-retryable line(s)");
let repeated = lines | where retryable | summarize n = count() by projectId | where n >= 2 | project problem = strcat("project ", projectId, ": ", n, " retryable line(s)");
union hard, repeated
'''
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

// With Track pushing every write, the nightly teams sync should find nothing to create or update,
// and no new orphans. Judges the latest live line only; the 48h span is the log alert maximum.
resource trackDriftAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = if (deployTrackDriftAlert && !empty(syncTeamsSchedule)) {
  name: 'demi-track-drift-${environmentName}'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'DEMI Track project mirror drifted'
    description: 'The latest `[track-teams] mode=live` line with trackProjects above 0 shows created or updated above 0, or more orphaned projects than the night before. A Track write did not reach DEMI by push, and the nightly sync caught it. Alembic data migrations, a test DB refresh and lookup renames also trigger this by design. Limit: a missing or failed night leaves no baseline within the 48 hour maximum, so that night\'s orphan rise is missed. Check Track logs for `demi-push failed`; the orphan rise names its ids in the sync output.'
    severity: 2
    enabled: true
    scopes: [ workspace.id ]
    evaluationFrequency: 'PT1H'
    windowSize: 'P2D'
    criteria: {
      allOf: [
        {
          query: '''
let span = 48h;
let live = AppTraces | where TimeGenerated > ago(span) and Message startswith "[track-teams] mode=live"
| extend trackProjects = toint(extract("trackProjects=([0-9]+)", 1, Message)), created = toint(extract("created=([0-9]+)", 1, Message)), updated = toint(extract("updated=([0-9]+)", 1, Message)), orphaned = toint(extract("orphaned=([0-9]+)", 1, Message))
| where trackProjects > 0
| sort by TimeGenerated asc
| extend previous = prev(orphaned);
live | top 1 by TimeGenerated | where created > 0 or updated > 0 or orphaned > previous
'''
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
    // Not auto-resolved: a rule still firing from last night would send no mail for tonight's drift.
    autoMitigate: false
    muteActionsDuration: 'PT23H'
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
