// Cosmos spend, seen within the hour instead of a day or two later.
//
// Serverless Cosmos bills per request unit, so a loop that keeps writing costs money for as long
// as it runs. In September 2026 a chunk-ingest retry loop held demi-cosmos-test at 4-8M RU an hour
// (about 70 CAD a day) for five days, and the only alarm was the budget in cost-budget.bicep, whose
// cost data lags 24-48 hours. This rule reads the RU metric itself, which lands within minutes.
//
// Its own module because of ordering, not taste: observability.bicep would be the obvious home,
// but cosmos-nosql.bicep takes the audit workspace from audit-logs.bicep, which takes the action
// group from observability.bicep. Handing the Cosmos id back to observability would close a cycle.

@description('Environment name (e.g. dev, test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

@description('Resource id of the Cosmos account to watch')
param cosmosAccountId string

@description('Action group to notify; owned by observability.bicep')
param actionGroupId string

@description('Total request units in one hour above which the alert fires. Sized per environment in the .bicepparam files.')
param ruPerHourThreshold int

resource cosmosRuAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'demi-cosmos-ru-${environmentName}'
  // Metric alerts are global; the region is the resource's, not the rule's.
  location: 'global'
  tags: tags
  properties: {
    description: 'Cosmos used more than ${ruPerHourThreshold} request units in the last hour. Serverless bills every RU, so this is money being spent now. Look for a loop first: the demi-chunk-ingest-failures alert and AppTraces lines with `chunk ingest rejected` or `chunk write incomplete`.'
    // Warning: nothing is down, but it costs money every hour it stays raised.
    severity: 2
    enabled: true
    scopes: [ cosmosAccountId ]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT1H'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          name: 'TotalRequestUnitsPerHour'
          metricNamespace: 'Microsoft.DocumentDB/databaseAccounts'
          metricName: 'TotalRequestUnits'
          // Account-wide: no dimension filter, so a loop on any container counts.
          timeAggregation: 'Total'
          operator: 'GreaterThan'
          threshold: ruPerHourThreshold
        }
      ]
    }
    autoMitigate: true
    actions: [
      {
        actionGroupId: actionGroupId
      }
    ]
  }
}
