// Azure Consumption Budget Module for DEMI Cost Control
@description('Environment name (e.g. dev, test, prod)')
param environmentName string

// ONE budget here: the monthly anomaly guard. The absolute annual ceiling for everything EPIC owns
// lives at the c4b0a8 management group (digitalspace/eagle-edge `azure/budget-mg.bicep`).
// The monthly guard is an anomaly detector sized to the run rate, not a limit.
//
// RE-MEASURED 2026-08-17, and the previous figure here was wrong by 7x. It read 18.71 CAD over
// "the first 12 days of August" and inferred ~47 CAD/month — but c4b0a8-test-rg did not exist
// before 2026-08-10, so that average spread ~2 days of real billing across 12. The 150 default it
// produced was breached the moment the estate finished deploying.
//
// Actual, from Cost Management ActualCost grouped by ResourceId (NOT `currentSpend`, which reports
// 0.0 on both budgets here and cannot be trusted): daily 10.40-13.25 CAD over Aug 11-15, mean
// 11.44, i.e. a run rate near 350 CAD/month. It is dominated by standing charges that no amount of
// tuning removes — 2x Azure AI Search Basic at 188 (deliberately kept as two services until DEMI
// reaches production), Defender for Cloud at ~82, Front Door base fee 42, four private endpoints
// 37. Application compute is about 5% of it.
//
// Sized at 400: above the ~350 run rate plus the Defender-for-Storage cut still pending a
// landing-zone ruling, and still low enough to catch a runaway indexer or a left-on resource. Do
// not lower it back toward the run rate — an alert that fires every month is not a control, which
// is the same reason the annual ceiling below is a separate number.
//
// CAD, not USD: a Consumption Budget is denominated in the subscription's BILLING currency, which
// this one reports as CAD. The parameter name cannot pick a currency, so mislabelling it here is
// how a 100 ceiling gets read as ~137.
@description('Monthly anomaly guard in CAD. Set above the measured run rate (~350 CAD/month as of 2026-08-17), not a multiple of it: this estate is mostly standing charges, so the headroom that matters is for a runaway indexer or a left-on resource, not for normal variance.')
param budgetAmount int = 400


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
@description('First day of the budget period. Defaults to the first of the current month for a NEW budget; an existing budget REJECTS any startDate change, so param files pin the live value.')
param startDate string = ''
param nowMonth string = utcNow('yyyy-MM-01')
var effectiveStartDate = empty(startDate) ? nowMonth : startDate

var budgetName = 'demi-budget-${environmentName}'

resource costBudget 'Microsoft.Consumption/budgets@2021-10-01' = {
  name: budgetName
  properties: {
    category: 'Cost'
    amount: budgetAmount
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: '${effectiveStartDate}T00:00:00Z'
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

output budgetName string = costBudget.name
