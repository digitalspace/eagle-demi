'use strict';

/**
 * config.js — Environment variable helpers.
 *
 * Env vars:
 *   MINIO_HOST, MINIO_PORT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY,
 *   MINIO_BUCKET_NAME, MINIO_USE_SSL
 *   DOCLING_URL          — docling-serve base URL (default: http://eagle-demi:5000)
 *   DOCLING_API_KEY      — X-Api-Key for docling-serve
 *
 * NO DATABASE SETTINGS. The Cosmos NoSQL client reads `COSMOS_NOSQL_DATABASE` itself and
 * authenticates with a managed identity (`src/db/cosmos-nosql.js`); this file has nothing to
 * contribute to it. The `MONGODB_` and `COSMOSDB_` keys, and the `mongodb://` URI builder that
 * used to live here, went with the Mongo account — they were read by nothing, and defaulted to
 * `localhost:27017`, so anything that picked them up would have connected somewhere real-looking
 * and empty.
 */

const config = {
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

  // Which object-storage backend serves documents: 'minio' or 'azure'.
  //
  // Explicit, never inferred from whichever credentials happen to be present. Inferring a mode
  // switch from unrelated config is how COSMOS_ENDPOINT silently activated the wrong data layer
  // on deploy. An unknown value throws at load rather than falling back — see src/storage/.
  storageBackend: process.env.STORAGE_BACKEND || 'minio',

  // Azure Blob backend. Keyless: auth is Entra managed identity, so there is no account key
  // here to leak or rotate. Each environment gets its OWN container, which is what makes
  // "dev accidentally points at prod storage" structurally impossible rather than merely
  // discouraged — so there is no key-prefix equivalent.
  azureStorageAccount:   process.env.AZURE_STORAGE_ACCOUNT || '',
  azureStorageContainer: process.env.AZURE_STORAGE_CONTAINER || '',

  doclingUrl:   process.env.DOCLING_URL      || 'http://eagle-demi:5000',
  doclingKey:   process.env.DOCLING_API_KEY  || '',

  // Paragraphs accumulate to TARGET before a chunk is emitted; MAX is the hard split point and
  // MIN is only the floor below which a trailing fragment is folded into the previous chunk.
  //
  // TARGET = 2500 IS CURRENTLY UNJUSTIFIED. It was derived against Typesense, which held its index
  // in RAM and paid ~1.1 KB per 601-character chunk, so per-chunk overhead dominated the text and
  // merging up to ~2500 cut the corpus from ~3.1M chunks to ~740k. AI Search has no such cost, so
  // that argument no longer applies to anything. The real lever now is retrieval: chunks are the
  // unit a conjunctive query must match within, so larger chunks satisfy AND more often and dilute
  // BM25 term density, and smaller ones do the reverse. That trade can only be settled by
  // re-chunking at several sizes and scoring — see the sweep planned with the re-ingest. Until
  // then this number is inherited, not chosen.
  maxChunkSize:    parseInt(process.env.MAX_CHUNK_SIZE    || '4000', 10),
  targetChunkSize: parseInt(process.env.TARGET_CHUNK_SIZE || '2500', 10),
  minChunkSize:    parseInt(process.env.MIN_CHUNK_SIZE    || '100',  10),
  overlapSize:     parseInt(process.env.OVERLAP_SIZE      || '200',  10),

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
