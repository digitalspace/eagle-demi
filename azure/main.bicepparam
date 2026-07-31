using './main.bicep'

param environmentName = 'dev'
param location = 'canadacentral'
param minioHost = 'minio-6cdc9e-dev.apps.silver.devops.gov.bc.ca'
param minioAccessKey = 'minio'
param minioSecretKey = 'minio123'
// budgetAmount deliberately unset — main.bicep's default is the single source of truth for the
// ceiling. Setting it here silently reverted the raise to 100 on the next deployment.
param contactEmails = [
  'Daniel.T.Truong@gov.bc.ca'
]
