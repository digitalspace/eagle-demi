'use strict';

/**
 * config.js — Environment variable helpers for eagle-demi worker.
 *
 * Required env vars:
 *   MONGODB_HOST, MONGODB_PORT, MONGODB_DATABASE, MONGODB_USERNAME,
 *   MONGODB_PASSWORD, MONGODB_AUTHSOURCE, MONGODB_DIRECT
 *   MINIO_HOST, MINIO_PORT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY,
 *   MINIO_BUCKET_NAME, MINIO_USE_SSL
 *   DOCLING_URL          — docling-serve base URL (default: http://eagle-demi:5000)
 *   DOCLING_API_KEY      — X-Api-Key for docling-serve
 */

function buildCosmosDbUri() {
  const uri = process.env.COSMOSDB_URI || process.env.MONGODB_URI;
  if (uri) {
    if ((uri.includes('documents.azure.com') || uri.includes('cosmos')) && !uri.includes('retryWrites=')) {
      const joinChar = uri.includes('?') ? '&' : '?';
      return `${uri}${joinChar}retryWrites=false`;
    }
    return uri;
  }
  const user = encodeURIComponent(process.env.COSMOSDB_USERNAME || process.env.MONGODB_USERNAME || '');
  const pass = encodeURIComponent(process.env.COSMOSDB_PASSWORD || process.env.MONGODB_PASSWORD || '');
  const host = process.env.COSMOSDB_HOST || process.env.MONGODB_HOST || 'localhost';
  const port = process.env.COSMOSDB_PORT || process.env.MONGODB_PORT || '27017';
  const db   = process.env.COSMOSDB_DATABASE || process.env.MONGODB_DATABASE || 'epic';

  if (user && pass) {
    return `mongodb://${user}:${pass}@${host}:${port}/${db}?retryWrites=false`;
  }
  return `mongodb://${host}:${port}/${db}?retryWrites=false`;
}

const config = {
  cosmosDbUri:        buildCosmosDbUri(),
  cosmosDatabaseName: process.env.COSMOSDB_DATABASE || process.env.MONGODB_DATABASE || 'epic',
  // Backward compatibility aliases
  mongoUri:           buildCosmosDbUri(),
  mongoDb:            process.env.COSMOSDB_DATABASE || process.env.MONGODB_DATABASE || 'epic',

  minioHost:    process.env.MINIO_HOST       || 'localhost',
  minioPort:    parseInt(process.env.MINIO_PORT || '9000', 10),
  // Pinning the region lets the SDK sign presigned URLs locally. Without it, the client
  // performs a bucket-region lookup against MinIO on every presign — which hangs for
  // ~135s from Azure before failing, since MinIO lives on OpenShift Silver.
  minioRegion:  process.env.MINIO_REGION      || 'us-east-1',
  minioAccess:  process.env.MINIO_ACCESS_KEY || '',
  minioSecret:  process.env.MINIO_SECRET_KEY || '',
  minioBucket:  process.env.MINIO_BUCKET_NAME || 'uploads',
  minioSsl:     process.env.MINIO_USE_SSL === 'true',
  // Path segment prepended to every stored object key.
  //
  // Documents carry the key eagle-api recorded against the PROD bucket (`etl/<slug>/<file>`).
  // Non-prod buckets hold a copy of prod nested one level down, under a prefix named after
  // the prod bucket — e.g. dev's bucket `asnpnn` contains `ozwdez/etl/...`. So the stored
  // metadata and the actual layout differ by exactly one segment, per environment.
  //
  // Empty in prod, `ozwdez/` in dev. Set MINIO_KEY_PREFIX per environment.
  // This disappears once documents move to Azure Blob with a single clean key layout.
  minioKeyPrefix: process.env.MINIO_KEY_PREFIX || '',

  doclingUrl:   process.env.DOCLING_URL      || 'http://eagle-demi:5000',
  doclingKey:   process.env.DOCLING_API_KEY  || '',

  maxChunkSize: parseInt(process.env.MAX_CHUNK_SIZE || '4000', 10),
  minChunkSize: parseInt(process.env.MIN_CHUNK_SIZE || '100',  10),
  overlapSize:  parseInt(process.env.OVERLAP_SIZE   || '200',  10),

  // Docling request timeout in ms (large docs can take minutes)
  doclingTimeout: parseInt(process.env.DOCLING_TIMEOUT_MS || '300000', 10),

  batchSize: parseInt(process.env.BATCH_SIZE || '50', 10),

  uploadDir:             process.env.UPLOAD_DIRECTORY || '/tmp',
  enableVirusScanning:   process.env.ENABLE_VIRUS_SCANNING === 'true',

  // Logging Configuration
  logLevel:              process.env.LOG_LEVEL || 'info',
  logCappedSizeBytes:    parseInt(process.env.LOG_CAPPED_SIZE_BYTES || '52428800', 10), // 50MB
  logCappedMaxDocuments: parseInt(process.env.LOG_CAPPED_MAX_DOCUMENTS || '100000', 10),

  // Keycloak & Token Authentication
  keycloakUrl:           process.env.KEYCLOAK_URL || 'https://dev.loginproxy.gov.bc.ca/auth',
  keycloakRealm:         process.env.KEYCLOAK_REALM || 'eao-epic',
  keycloakClientId:      process.env.KEYCLOAK_CLIENT_ID || 'eagle-admin-console',
  keycloakEnabled:       process.env.KEYCLOAK_ENABLED !== 'false',
  ssoJwksUri:            process.env.SSO_JWKSURI || `${process.env.KEYCLOAK_URL || 'https://dev.loginproxy.gov.bc.ca/auth'}/realms/${process.env.KEYCLOAK_REALM || 'eao-epic'}/protocol/openid-connect/certs`,
  ssoIssuer:             process.env.SSO_ISSUER || `${process.env.KEYCLOAK_URL || 'https://dev.loginproxy.gov.bc.ca/auth'}/realms/${process.env.KEYCLOAK_REALM || 'eao-epic'}`,
};

module.exports = config;
