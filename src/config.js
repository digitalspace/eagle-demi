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

/**
 * A whole non-negative number from the environment, or the fallback when the variable is unset.
 *
 * Throws at load, like the allowedClients guard below: a cap that parsed to NaN compares false
 * against every value, so the failure mode of a silent parse is an unlimited limit.
 */
function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a whole non-negative number, got '${raw}'.`);
  }
  return value;
}

/** `HH:MM:SS` from host.json into milliseconds; throws at load on any other shape. */
function timeSpanMs(value) {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(value));
  if (!m) throw new Error(`[config] not a time span: ${value}`);
  return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000;
}

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

  // Keys under a project's `sources` that may leave over HTTP (src/vis/redact.js).
  // Empty = no enrichment is published, which is what prod runs.
  enrichmentSources: (process.env.ENRICHMENT_SOURCES || '').split(',').map(s => s.trim()).filter(Boolean),

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

  // Bulk document download (PUBLIC-148). Caps REFUSE rather than truncate: a job that silently
  // dropped documents would hand someone an incomplete download they had no way to notice.
  //
  // intFromEnv, not parseInt: `parseInt('2500 docs')` is 2500 and `parseInt('lots')` is NaN, and a
  // NaN cap compares false against everything, so a typo in an app setting would remove the limit
  // instead of failing the deploy.
  bulkMaxDocuments:     intFromEnv('BULK_MAX_DOCUMENTS', 2500),
  bulkAnonMaxDocuments: intFromEnv('BULK_ANON_MAX_DOCUMENTS', 100),
  // Per ZIP PART: a job over this is split into numbered parts, not refused.
  bulkMaxBytes:         intFromEnv('BULK_MAX_BYTES', 2147483648),
  // Whole job. The one byte ceiling that refuses.
  bulkMaxTotalBytes:    intFromEnv('BULK_MAX_TOTAL_BYTES', 21474836480),
  // Concurrent jobs per requester. No app rate limiter exists and APIM Consumption cannot key-limit
  // an anonymous caller, so this is the abuse boundary for the feature.
  bulkMaxPending:       intFromEnv('BULK_MAX_PENDING', 3),
  // Jobs one requester may start in 24 hours. bulkMaxPending alone bounds concurrency only: a
  // caller who waits for each job to finish can start an unlimited number of them.
  bulkMaxPerDay:        intFromEnv('BULK_MAX_PER_DAY', 20),
  // How old a job may be when the worker picks it up. The access snapshot on the row is a copy of
  // the caller's roles at submit time, so a message that sat in the queue past this is refused
  // rather than run against credentials nobody has re-checked since.
  bulkMaxJobAgeMs:      intFromEnv('BULK_MAX_JOB_AGE_MS', 7_200_000),
  // When a `running` job is reported as failed instead: the queue's visibility timeout, read from
  // host.json so the two cannot drift (below it a hidden message reads as dead, above it a
  // returned one reads as alive).
  bulkStaleRunningMs:   timeSpanMs(require('../host.json').extensions.queues.visibilityTimeout),
  bulkZipRetentionDays: intFromEnv('BULK_ZIP_RETENTION_DAYS', 7),
  bulkJobTtlDays:       intFromEnv('BULK_JOB_TTL_DAYS', 30),
  // Empty = the feature is OFF. Azure drops an app setting whose value is '', so an unset variable
  // must mean disabled rather than fall back to a queue name nothing is bound to.
  bulkDownloadsQueue:   process.env.BULK_DOWNLOADS_QUEUE || '',
  bulkCleanupSchedule:  process.env.BULK_CLEANUP_SCHEDULE || '',

  uploadDir:             process.env.UPLOAD_DIRECTORY || '/tmp',

  logLevel:              process.env.LOG_LEVEL || 'info',

  // AI summarizer (see wiki ADR-006). Step 5 of the search pipeline and the only one that touches
  // a model — retrieval is untouched lexical BM25.
  //
  // Keyless: the deployment is reached with the app's managed identity, so there is NO key here and
  // none is wanted. `foundryEndpoint` is a hostname; this repo is public.
  //
  // Defaults to OFF. The endpoint does not exist until the Foundry account is provisioned, and a
  // summariser that half-works is worse than one that is plainly absent — every caller path returns
  // `{ summary: null }` while this is false.
  summaryEnabled:    process.env.SUMMARY_ENABLED === 'true',
  foundryEndpoint:   process.env.FOUNDRY_ENDPOINT || '',
  foundryDeployment: process.env.FOUNDRY_DEPLOYMENT || '',
  foundryApiVersion: process.env.FOUNDRY_API_VERSION || '2024-10-21',

  // The cost and latency ceiling, enforced before the request rather than hoped for after it.
  // 8 × 1500 chars ≈ 3k input tokens ≈ 0.0021 CAD/query. Raising either raises the bill linearly, so
  // they are configuration and the probe asserts p95 prompt_tokens stays under the implied cap.
  summaryMaxChunks:  parseInt(process.env.SUMMARY_MAX_CHUNKS || '8', 10),
  summaryMaxChars:   parseInt(process.env.SUMMARY_MAX_CHARS  || '1500', 10),
  summaryMaxTokens:  parseInt(process.env.SUMMARY_MAX_TOKENS || '400', 10),
  // Well inside the App Service 240 s request ceiling. The panel is additive: a timeout renders
  // nothing and must never take the three result columns down with it.
  summaryTimeoutMs:  parseInt(process.env.SUMMARY_TIMEOUT_MS || '20000', 10),

  // CAD per million tokens, for turning the usage the deployment reports into a number a human can
  // read.
  //
  // CAD, not USD, because this subscription is billed in CAD — `az consumption budget list` reports
  // `demi-budget-dev` in CAD, and every other cost figure in the wiki is CAD. A per-query
  // number in a second currency is one someone has to convert before it can be compared to the
  // budget it draws down.
  //
  // These rates are MODEL- AND SKU-SPECIFIC and must track `azure/modules/foundry.bicep`. They are
  // the `gpt 4.1 mini Inp regnl` / `Outp regnl` retail meters in canadaeast — regional, because the
  // deployment's `sku.name` is `Standard`. Changing `modelName`, or moving that SKU to
  // `GlobalStandard` (a cheaper meter: 0.60 / 2.30 CAD), makes these wrong and every displayed cost
  // wrong with them. They once carried 4o-mini USD rates against a gpt-4.1-mini deployment and
  // understated every query by 3.2x, which is the failure this comment exists to prevent repeating.
  //
  // Refresh with:
  //   curl -s "https://prices.azure.com/api/retail/prices?currencyCode='CAD'&\$filter=\
  //   armRegionName eq 'canadaeast' and contains(meterName,'gpt 4.1 mini')"
  // `unitPrice` is per 1K tokens, so multiply by 1000. Azure publishes CAD to four decimal places
  // at that unit, so these carry roughly a percent of quantization — immaterial at this magnitude.
  //
  // This yields an ESTIMATE and must be labelled as one wherever it is shown. Azure bills on its
  // own meter with its own rounding, list rates change without this file changing, and any
  // negotiated or committed-use discount is invisible here. It is for spotting a query that costs
  // 50x the others — not for reconciling an invoice.
  summaryCostPerMTokIn:  parseFloat(process.env.SUMMARY_COST_PER_MTOK_IN  || '0.70'),
  summaryCostPerMTokOut: parseFloat(process.env.SUMMARY_COST_PER_MTOK_OUT || '2.70'),

  // Audit and usage analytics — Azure Monitor Logs ingestion (see azure/modules/audit-logs.bicep).
  //
  // Keyless: the app publishes with its user-assigned identity, which holds Monitoring Metrics
  // Publisher on the DCR and nothing else. There is no key here and none is wanted.
  //
  // Both empty is the local-development and test case, and the writer treats it as OFF rather than
  // as an error — an audit call must never be the reason a request fails. Same shape as
  // SEARCH_ENDPOINT: absent endpoint disables the feature instead of breaking the caller.
  auditDcrEndpoint:    process.env.AUDIT_DCR_ENDPOINT || '',
  auditDcrImmutableId: process.env.AUDIT_DCR_IMMUTABLE_ID || '',
  // Flush triggers. Whichever fires first wins. 800 KB leaves headroom under the 1 MB per-call
  // ingestion limit for the JSON envelope.
  auditFlushMs:        parseInt(process.env.AUDIT_FLUSH_MS || '1000', 10),
  auditMaxBatch:       parseInt(process.env.AUDIT_MAX_BATCH || '100', 10),
  auditMaxBatchBytes:  parseInt(process.env.AUDIT_MAX_BATCH_BYTES || '800000', 10),

  // Keycloak & Token Authentication
  keycloakUrl:           process.env.KEYCLOAK_URL || 'https://dev.loginproxy.gov.bc.ca/auth',
  keycloakRealm:         process.env.KEYCLOAK_REALM || 'eao-epic',
  keycloakClientId:      process.env.KEYCLOAK_CLIENT_ID || 'eagle-admin-console',
  keycloakEnabled:       process.env.KEYCLOAK_ENABLED !== 'false',
  // Tag baked into minted API keys so a dev key is visibly not a prod key. Cosmetic only —
  // nothing authorises on it.
  // ENVIRONMENT, and only ENVIRONMENT: it is what api-function-flex.bicep sets. It labels every
  // audit row and tags minted API keys, so a name no template sets resolves to 'dev' everywhere.
  environmentName:       process.env.ENVIRONMENT || 'dev',
  // Keycloak clients (azp) permitted to call this API at all. Empty admits every client, which is
  // why the guard below refuses to boot test or prod on an empty list. See helpers/auth.isAllowedClient.
  allowedClients:        (process.env.DEMI_ALLOWED_CLIENTS || '').split(',').map(s => s.trim()).filter(Boolean),
  // Short links: destinations are allowlisted by hostname suffix at write time (helpers/link-url).
  // linkBaseUrl is a Bicep app setting per environment so test hands back the test host, not prod's.
  linkAllowedHosts:      (process.env.LINK_ALLOWED_HOSTS || 'gov.bc.ca').split(',').map(s => s.trim()).filter(Boolean),
  linkBaseUrl:           process.env.LINK_BASE_URL || 'https://projects.eao.gov.bc.ca',

  // Track team feed → `project:<id>` realm roles (src/scripts/sync-track-teams.js). Two
  // client-credentials identities in the realm above: one reads Track, one holds
  // `realm-management`. Empty everywhere the sync is not scheduled, which is every environment
  // until SYNC_TEAMS_SCHEDULE is set.
  trackApiBase:              process.env.TRACK_API_BASE || '',
  trackClientId:             process.env.TRACK_CLIENT_ID || '',
  trackClientSecret:         process.env.TRACK_CLIENT_SECRET || '',
  keycloakAdminClientId:     process.env.KEYCLOAK_ADMIN_CLIENT_ID || '',
  keycloakAdminClientSecret: process.env.KEYCLOAK_ADMIN_CLIENT_SECRET || '',

  ssoJwksUri:            process.env.SSO_JWKSURI || `${process.env.KEYCLOAK_URL || 'https://dev.loginproxy.gov.bc.ca/auth'}/realms/${process.env.KEYCLOAK_REALM || 'eao-epic'}/protocol/openid-connect/certs`,
  ssoIssuer:             process.env.SSO_ISSUER || `${process.env.KEYCLOAK_URL || 'https://dev.loginproxy.gov.bc.ca/auth'}/realms/${process.env.KEYCLOAK_REALM || 'eao-epic'}`,
  // Empty = not enforced. No default value: an unmeasured audience 401s every caller, so this
  // stays off until someone reads `aud` off a live token per realm.
  ssoAudience:           process.env.SSO_AUDIENCE || '',
};

// Fail to boot rather than run a deployed environment with an allowlist that admits every client
// in the realm. Only dev and local keep the permissive default, so a new ENVIRONMENT name is
// treated as deployed rather than silently admitting the whole realm.
if (config.environmentName !== 'dev' && config.environmentName !== 'local' &&
    config.allowedClients.length === 0) {
  throw new Error(
    `DEMI_ALLOWED_CLIENTS must name at least one Keycloak client in ${config.environmentName}.`
  );
}

module.exports = config;
