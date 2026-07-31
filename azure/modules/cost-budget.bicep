// Azure Consumption Budget Module for DEMI Cost Control
@description('Environment name (e.g. dev, test, prod)')
param environmentName string

// 100, not 50: Azure AI Search Basic is a FIXED ~$75-81/mo whether it is queried or idle, so the
// old ceiling would sit permanently in alert and stop meaning anything. Raise this deliberately
// whenever a fixed-rate service is added — an alert that always fires is not a control.
@description('Monthly Budget Amount in USD (e.g. 100)')
param budgetAmount int = 100

@description('Email addresses to receive budget threshold alerts')
param contactEmails array = [
  'Daniel.T.Truong@gov.bc.ca'
]

var budgetName = 'demi-budget-${environmentName}'

resource costBudget 'Microsoft.Consumption/budgets@2021-10-01' = {
  name: budgetName
  properties: {
    category: 'Cost'
    amount: budgetAmount
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: '2026-08-01T00:00:00Z'
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
  }
}

output budgetName string = costBudget.name
