// Azure Consumption Budget Module for DEMI Cost Control
@description('Environment name (e.g. dev, test, prod)')
param environmentName string

// TWO budgets, because "keep costs down" and "never exceed the ceiling" are different controls and
// a single number cannot serve both. The monthly one is an anomaly detector sized to the observed
// run rate; the annual one is the actual limit. A budget set at the ceiling would let a tenfold
// overspend run for months without a word, and a budget set at the run rate would be permanently
// in alert — an alert that always fires is not a control.
//
// MEASURED 2026-08-12: 18.71 CAD spent in the first 12 days of August on c4b0a8-test
// (`az consumption budget list` → currentSpend), i.e. a run rate near 47 CAD/month. That is the
// number these defaults are sized against, and it supersedes the old comment here claiming Azure
// AI Search Basic alone was a fixed ~75-81 CAD/month — the whole resource group, AI Search
// included, is not currently costing that. Re-measure before trusting either figure.
//
// CAD, not USD: a Consumption Budget is denominated in the subscription's BILLING currency, which
// this one reports as CAD. The parameter name cannot pick a currency, so mislabelling it here is
// how a 100 ceiling gets read as ~137.
@description('Monthly anomaly guard in CAD. Roughly 3x the observed run rate: high enough not to cry wolf on normal variance, low enough to catch a runaway indexer, a log loop or a left-on resource within days rather than at year end.')
param budgetAmount int = 150

@description('The absolute annual ceiling in CAD. Not a target - spending anywhere near it should be a decision somebody made on purpose, which is why the alerts below start at half.')
param annualCeiling int = 50000

@description('Email addresses to receive budget threshold alerts')
param contactEmails array = [
  'Daniel.T.Truong@gov.bc.ca'
]

// utcNow() is only legal as a parameter default in Bicep, which is exactly the shape wanted here:
// evaluated once at deployment, never drifting on a redeploy of an unchanged template.
//
// The old hardcoded 2026-08-01 pinned the ANNUAL budget's year to August-August forever, and gave
// any environment created later a period that had already partly elapsed - so a new environment
// would start life with months of its ceiling notionally spent.
@description('First day of the budget period. Defaults to the first of the current month; override only to reproduce a historical period.')
param startDate string = utcNow('yyyy-MM-01')

var budgetName = 'demi-budget-${environmentName}'

resource costBudget 'Microsoft.Consumption/budgets@2021-10-01' = {
  name: budgetName
  properties: {
    category: 'Cost'
    amount: budgetAmount
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: '${startDate}T00:00:00Z'
    }
    notifications: {
      Actual_80_Percent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 80
        contactEmails: contactEmails
      }
      Actual_100_Percent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        contactEmails: contactEmails
      }
      // Forecast, not actual: this is the only notification that can arrive while the money is
      // still unspent. Azure projects the month from the trend so far, so a resource left running
      // on the 3rd is reported on the 4th rather than confirmed on the 30th.
      Forecasted_100_Percent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        contactEmails: contactEmails
        thresholdType: 'Forecasted'
      }
    }
  }
}

// The ceiling. Deliberately separate from the monthly guard: a single overspending month is a
// question, a year-to-date trajectory toward 50k is a decision, and they should not share a
// threshold or an inbox subject line.
//
// SCOPE CAVEAT: main.bicep targets a resource group, so this budget sees c4b0a8-<env>-rg only -
// which also holds eagle-search and eagle-extractor, but NOT any other resource group or
// subscription. If 50k is meant to cover the whole EPIC.AI account, the ceiling belongs in a
// subscription-scope deployment; this one is an honest lower bound on spend, not a total.
resource annualBudget 'Microsoft.Consumption/budgets@2021-10-01' = {
  name: 'demi-ceiling-${environmentName}'
  properties: {
    category: 'Cost'
    amount: annualCeiling
    timeGrain: 'Annually'
    timePeriod: {
      startDate: '${startDate}T00:00:00Z'
    }
    // Starting at 50%: at the measured run rate the year lands near 1% of this, so anything that
    // reaches half the ceiling has changed by two orders of magnitude and is worth knowing about
    // long before it is urgent.
    notifications: {
      Actual_50_Percent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 50
        contactEmails: contactEmails
      }
      Actual_80_Percent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 80
        contactEmails: contactEmails
      }
      Forecasted_90_Percent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 90
        contactEmails: contactEmails
        thresholdType: 'Forecasted'
      }
    }
  }
}

output budgetName string = costBudget.name
output annualBudgetName string = annualBudget.name
