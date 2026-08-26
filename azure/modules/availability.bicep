// Synthetic availability monitoring for the public search path. The Application Insights component
// and the action group are passed in, not created.
//
// WHAT IT PROVES: one HTTP GET along the whole chain a visitor uses — Front Door, rproxy, the app,
// AI Search — so a 200 means every hop answered. Nothing else notices the API being down:
// Application Insights records requests only while the app is there to record them, and rproxy
// keeps answering healthily when its upstream is gone.

@description('Region for the web test. Must match the Application Insights component it links to.')
param location string

@description('Environment name (e.g. dev, test, prod)')
param environmentName string

@description('Default resource tags')
param tags object

@description('Absolute URL the probe fleet GETs.')
param targetUrl string

@description('Resource ID of the Application Insights component that records the results.')
param appInsightsId string

@description('Action group notified when availability drops.')
param actionGroupId string

var webTestName = 'demi-search-availability-${environmentName}'

// Five locations is Microsoft's floor for suppressing false alarms; the threshold below then needs
// more than one to fail. There is no Canadian probe location, so West US is the closest to BC.
var probeLocations = [
  { Id: 'us-ca-sjc-azr' }
  { Id: 'us-il-ch1-azr' }
  { Id: 'us-tx-sn1-azr' }
  { Id: 'us-va-ash-azr' }
  { Id: 'us-fl-mia-edge' }
]

resource webTest 'Microsoft.Insights/webtests@2022-06-15' = {
  name: webTestName
  location: location
  tags: union(tags, {
    // Required, not decorative: without it the portal does not associate the test with the component
    // and the availability blade renders empty, which reads like a test that is not running.
    'hidden-link:${appInsightsId}': 'Resource'
  })
  kind: 'standard'
  properties: {
    SyntheticMonitorId: webTestName
    Name: webTestName
    Enabled: true
    Frequency: 300
    Timeout: 30
    Kind: 'standard'
    RetryEnabled: true
    Locations: probeLocations
    Request: {
      RequestUrl: targetUrl
      HttpVerb: 'GET'
      ParseDependentRequests: false
      // Keeps 1,440 synthetic searches a day out of the usage analytics — src/utils/audit.js skips
      // the `search` event when it sees this.
      Headers: [
        { key: 'X-Synthetic-Probe', value: 'availability' }
      ]
    }
    // Status only. The response body is JSON whose contents move with the corpus, so a content match
    // would be a second thing to keep true.
    ValidationRules: {
      ExpectedHttpStatusCode: 200
      SSLCheck: true
      SSLCertRemainingLifetimeCheck: 14
    }
  }
}

resource availabilityAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: webTestName
  location: 'global'
  tags: tags
  properties: {
    description: '${targetUrl} did not answer 200 from the probe fleet.'
    severity: 1
    enabled: true
    scopes: [ appInsightsId ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'availability'
          criterionType: 'StaticThresholdCriterion'
          metricNamespace: 'microsoft.insights/components'
          metricName: 'availabilityResults/availabilityPercentage'
          // Scoped to this test: the component reports every web test linked to it.
          dimensions: [
            {
              name: 'availabilityResult/name'
              operator: 'Include'
              values: [ webTestName ]
            }
          ]
          operator: 'LessThan'
          // Not 100: five locations over a 15-minute window make one flaky probe run ~93%, and
          // paging on a single probe trains people to ignore the alert.
          threshold: 90
          timeAggregation: 'Average'
        }
      ]
    }
    autoMitigate: true
    actions: [ { actionGroupId: actionGroupId } ]
  }
}
