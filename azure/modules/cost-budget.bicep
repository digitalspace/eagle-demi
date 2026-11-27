// Azure Consumption Budget Module for DEMI Cost Control
@description('Environment name (e.g. dev, test, prod)')
param environmentName string

// Monthly anomaly guard; the annual ceiling is the c4b0a8 management-group budget (eagle-edge azure/budget-mg.bicep).
// CAD (billing currency), set per env above run rate: an alert that fires every month is not a control.
@description('Monthly anomaly guard in CAD. Set above the measured run rate, not a multiple of it: this estate is mostly standing charges, so the headroom that matters is for a runaway indexer or a left-on resource, not for normal variance.')
param budgetAmount int = 400

@description('Email addresses to receive budget threshold alerts')
param contactEmails array = [
  'Daniel.T.Truong@gov.bc.ca'
]

// utcNow() is only legal as a param default: evaluated once per deploy, so a redeploy never moves the period.
@description('First day of the budget period. Defaults to the first of the current month for a NEW budget; an existing budget REJECTS any startDate change, so param files pin the live value.')
param startDate string = ''
param nowMonth string = utcNow('yyyy-MM-01')
var effectiveStartDate = empty(startDate) ? nowMonth : startDate

@description('Budget name. Empty uses demi-budget-<env>, the whole-group budget the app reads as BUDGET_NAME.')
param name string = ''

@description('Resource ids the budget counts. Empty counts the whole resource group.')
param resourceIds array = []

var budgetName = 'demi-budget-${environmentName}'

resource costBudget 'Microsoft.Consumption/budgets@2021-10-01' = {
  name: empty(name) ? budgetName : name
  // union, so the whole-group budget's body stays as it was: no filter key at all.
  properties: union(empty(resourceIds) ? {} : {
    filter: {
      dimensions: {
        name: 'ResourceId'
        operator: 'In'
        values: resourceIds
      }
    }
  }, {
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
    }
  })
}

output budgetName string = costBudget.name
