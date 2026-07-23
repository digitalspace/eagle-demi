using './main.bicep'

param environmentName = 'dev'
param location = 'canadacentral'
param minioHost = 'minio-6cdc9e-dev.apps.silver.devops.gov.bc.ca'
param minioAccessKey = 'minio'
param minioSecretKey = 'minio123'
param typesenseApiKey = 'demi-typesense-dev-key'
param budgetAmount = 50
param contactEmails = [
  'Daniel.T.Truong@gov.bc.ca'
]
