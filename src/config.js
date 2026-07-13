'use strict';

/**
 * config.js — Environment variable helpers for eagle-demi worker.
 *
 * Required env vars:
 *   MONGODB_HOST, MONGODB_PORT, MONGODB_DATABASE, MONGODB_USERNAME,
 *   MONGODB_PASSWORD, MONGODB_AUTHSOURCE, MONGODB_DIRECT
 *   MINIO_HOST, MINIO_PORT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY,
 *   MINIO_BUCKET_NAME, MINIO_USE_SSL
 *   DOCLING_URL          — docling-serve base URL (default: http://eagle-demi:5001)
 *   DOCLING_API_KEY      — X-Api-Key for docling-serve
 */

function buildMongoUri() {
  const user = encodeURIComponent(process.env.MONGODB_USERNAME || '');
  const pass = encodeURIComponent(process.env.MONGODB_PASSWORD || '');
  const host = process.env.MONGODB_HOST     || 'localhost';
  const port = process.env.MONGODB_PORT     || '27017';
  const db   = process.env.MONGODB_DATABASE || 'epic';
  const auth = process.env.MONGODB_AUTHSOURCE || 'admin';
  const replication = process.env.MONGODB_DIRECT === 'true'
    ? 'directConnection=true'
    : 'replicaSet=rs0';

  if (user && pass) {
    return `mongodb://${user}:${pass}@${host}:${port}/${db}?authSource=${auth}&${replication}`;
  }
  return `mongodb://${host}:${port}/${db}?${replication}`;
}

const config = {
  mongoUri:     buildMongoUri(),
  mongoDb:      process.env.MONGODB_DATABASE || 'epic',

  minioHost:    process.env.MINIO_HOST       || 'localhost',
  minioPort:    parseInt(process.env.MINIO_PORT || '9000', 10),
  minioAccess:  process.env.MINIO_ACCESS_KEY || '',
  minioSecret:  process.env.MINIO_SECRET_KEY || '',
  minioBucket:  process.env.MINIO_BUCKET_NAME || 'uploads',
  minioSsl:     process.env.MINIO_USE_SSL === 'true',

  doclingUrl:   process.env.DOCLING_URL      || 'http://eagle-demi:5001',
  doclingKey:   process.env.DOCLING_API_KEY  || '',

  maxChunkSize: parseInt(process.env.MAX_CHUNK_SIZE || '4000', 10),
  minChunkSize: parseInt(process.env.MIN_CHUNK_SIZE || '100',  10),
  overlapSize:  parseInt(process.env.OVERLAP_SIZE   || '200',  10),

  // Docling request timeout in ms (large docs can take minutes)
  doclingTimeout: parseInt(process.env.DOCLING_TIMEOUT_MS || '300000', 10),

  batchSize: parseInt(process.env.BATCH_SIZE || '50', 10),

  uploadDir:             process.env.UPLOAD_DIRECTORY || '/tmp',
  enableVirusScanning:   process.env.ENABLE_VIRUS_SCANNING === 'true',

  // Keycloak & Token Authentication
  keycloakUrl:           process.env.KEYCLOAK_URL || 'https://dev.loginproxy.gov.bc.ca/auth',
  keycloakRealm:         process.env.KEYCLOAK_REALM || 'eao-epic',
  keycloakClientId:      process.env.KEYCLOAK_CLIENT_ID || 'eagle-admin-console',
  keycloakEnabled:       process.env.KEYCLOAK_ENABLED !== 'false',
  ssoJwksUri:            process.env.SSO_JWKSURI || `${process.env.KEYCLOAK_URL || 'https://dev.loginproxy.gov.bc.ca/auth'}/realms/${process.env.KEYCLOAK_REALM || 'eao-epic'}/protocol/openid-connect/certs`,
  ssoIssuer:             process.env.SSO_ISSUER || `${process.env.KEYCLOAK_URL || 'https://dev.loginproxy.gov.bc.ca/auth'}/realms/${process.env.KEYCLOAK_REALM || 'eao-epic'}`,
};

module.exports = config;
