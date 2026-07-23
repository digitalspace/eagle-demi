// Azure Consumption Budget Module for DEMI Cost Control
@description('Environment name (e.g. dev, test, prod)')
param environmentName string

@description('Monthly Budget Amount in USD (e.g. 50)')
param budgetAmount int = 50

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
