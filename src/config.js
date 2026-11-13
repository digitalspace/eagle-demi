'use strict';

// No database settings: src/db/cosmos-nosql.js reads its own and uses a managed identity.

// Throws at load: a cap that parsed to NaN compares false against every value, so a silent parse removes the limit.
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

// Throws at load on a bad entry: a typo would otherwise put every visitor on one shared quota key.
function proxyListFromEnv(name) {
  const entries = (process.env[name] || '').split(',').map(s => s.trim()).filter(Boolean);
  const shape = /^(\d{1,3})(\.\d{1,3}){3}(\/\d{1,2})?$/;
  for (const entry of entries) {
    if (!shape.test(entry) || entry.split('/')[0].split('.').some(o => Number(o) > 255)) {
      throw new Error(`${name} must be a comma list of IPv4 addresses or CIDR blocks, got '${entry}'.`);
    }
  }
  return entries;
}

const { isKeyVaultReference } = require('./utils/key-vault-reference');

// Names only. The logger requires this module, so src/utils/logger.js reports them, not this file.
const unresolvedSecrets = [];

// A failed Key Vault reference reaches the app as its literal text; read it as unset and record
// only the setting's name, never the value.
function secretFromEnv(name) {
  const raw = process.env[name];
  if (raw === undefined) return '';
  if (!isKeyVaultReference(raw)) return raw;
  if (!unresolvedSecrets.includes(name)) unresolvedSecrets.push(name);
  return '';
}

/** A comma list of registry principals. Unset takes `fallback`; set but empty is nobody. */
function principalsFromEnv(name, fallback = '') {
  const raw = process.env[name];
  return (raw === undefined ? fallback : raw).split(',').map(s => s.trim()).filter(Boolean);
}

const envTrim = (name) => (process.env[name] || '').trim();

/** A versionless Key Vault secret URI, or '' (vault read off). A version pins one value and rotation never lands. */
function vaultSecretUriFromEnv(name) {
  const uri = envTrim(name).replace(/^https:\/\/[^/]+/i, origin => origin.toLowerCase());
  if (uri && !/^https:\/\/[a-z0-9-]+\.vault\.azure\.net\/secrets\/[A-Za-z0-9-]+$/.test(uri)) {
    throw new Error(
      `${name} must be https://<vault>.vault.azure.net/secrets/<name>, with no version and no trailing slash.`);
  }
  return uri;
}

const EDGE_BAN_MODES = ['off', 'shadow', 'write'];
const EDGE_GATE_MODES = ['', 'log', 'enforce'];

const config = {
  minioHost:    process.env.MINIO_HOST       || 'localhost',
  minioPort:    parseInt(process.env.MINIO_PORT || '9000', 10),
  // Pinned so presigning stays local: a bucket-region lookup from Azure hangs about 135 s.
  minioRegion:  process.env.MINIO_REGION      || 'us-east-1',
  minioAccess:  secretFromEnv('MINIO_ACCESS_KEY'),
  minioSecret:  secretFromEnv('MINIO_SECRET_KEY'),
  minioBucket:  process.env.MINIO_BUCKET_NAME || 'uploads',
  minioSsl:     process.env.MINIO_USE_SSL === 'true',
  // Stored keys are the prod bucket's; this adds the one more segment a non-prod copy may nest under. Empty in prod.
  minioKeyPrefix: process.env.MINIO_KEY_PREFIX || '',

  // 'minio' or 'azure', explicit, never inferred from credentials present; src/storage/ throws on an unknown value.
  storageBackend: process.env.STORAGE_BACKEND || 'minio',

  // Keyless (managed identity). Each environment has its own container, so no key prefix exists.
  azureStorageAccount:   process.env.AZURE_STORAGE_ACCOUNT || '',
  azureStorageContainer: process.env.AZURE_STORAGE_CONTAINER || '',

  // Checked before any in-place rewrite of an original. Empty: the check refuses every object.
  backupAccount:   process.env.BACKUP_ACCOUNT || '',
  backupContainer: process.env.BACKUP_CONTAINER || '',

  doclingUrl:   process.env.DOCLING_URL      || 'http://eagle-demi:5000',
  doclingKey:   secretFromEnv('DOCLING_API_KEY'),

  // Compared only in controllers/gate.js, so it never reaches a browser. Empty is valid and what
  // prod runs: no gate, and POST /gate 404s.
  accessGatePassword: secretFromEnv('ACCESS_GATE_PASSWORD'),

  // Keys under a project's `sources` that may leave over HTTP. Empty publishes none.
  enrichmentSources: (process.env.ENRICHMENT_SOURCES || '').split(',').map(s => s.trim()).filter(Boolean),

  // MIN is the floor below which a trailing fragment folds into the previous chunk. TARGET is
  // inherited, not tuned for retrieval; changing any size needs a full re-ingest.
  maxChunkSize:    parseInt(process.env.MAX_CHUNK_SIZE    || '4000', 10),
  targetChunkSize: parseInt(process.env.TARGET_CHUNK_SIZE || '2500', 10),
  minChunkSize:    parseInt(process.env.MIN_CHUNK_SIZE    || '100',  10),
  overlapSize:     parseInt(process.env.OVERLAP_SIZE      || '200',  10),

  // Stops a runaway chunker; the largest real document makes about 21k chunks.
  // deleteChunksForDocument clears at most 25,000 per document, so more could never be removed.
  maxChunksPerDocument:       intFromEnv('MAX_CHUNKS_PER_DOCUMENT', 25000),
  // A host that retries 5xx forever is stopped after this many failures inside the window.
  chunkIngestMaxFailures:     intFromEnv('CHUNK_INGEST_MAX_FAILURES', 3),
  chunkIngestFailureWindowMs: intFromEnv('CHUNK_INGEST_FAILURE_WINDOW_MS', 24 * 60 * 60 * 1000),

  doclingTimeout: parseInt(process.env.DOCLING_TIMEOUT_MS || '300000', 10),

  batchSize: parseInt(process.env.BATCH_SIZE || '50', 10),

  // Largest answer ?inline=1 streams to a caller that is not anonymous and edge-stamped; bigger
  // ones get the 302. 0 = no streaming, 302 for all but an edge piece past byte 0 (503).
  downloadStreamMaxBytes: intFromEnv('DOWNLOAD_STREAM_MAX_BYTES', 33554432),
  // Streams per instance, 0 = no limit: past the edge pool (anonymous stamped) a 503, else the 302.
  downloadStreamMaxConcurrent: intFromEnv('DOWNLOAD_STREAM_MAX_CONCURRENT', 2),
  downloadStreamEdgeMaxConcurrent: intFromEnv('DOWNLOAD_STREAM_EDGE_MAX_CONCURRENT', 6),

  // Featured documents one project may hold; PUT /documents/:id answers 409 past it. 0 = nothing can be featured.
  featuredDocumentsMax: intFromEnv('FEATURED_DOCUMENTS_MAX', 5),

  // Bulk download caps refuse rather than truncate: a silently short download goes unnoticed.
  bulkMaxDocuments:     intFromEnv('BULK_MAX_DOCUMENTS', 2500),
  bulkAnonMaxDocuments: intFromEnv('BULK_ANON_MAX_DOCUMENTS', 100),
  // Per zip part: a job over this is split into numbered parts, not refused.
  bulkMaxBytes:         intFromEnv('BULK_MAX_BYTES', 2147483648),
  // Whole job. The one byte ceiling that refuses.
  bulkMaxTotalBytes:    intFromEnv('BULK_MAX_TOTAL_BYTES', 21474836480),
  // Object opens kept ahead of the archive append. Bounded by the sockets and buffers an instance
  // can hold, not by how slow the object store is.
  bulkFetchAhead:       intFromEnv('BULK_FETCH_AHEAD', 3),
  // Transfers at once. At 1 the worker is bound by one connection's throughput (about 6 MB/s,
  // docs/bulk-download-performance.md); fetch-ahead then overlaps only the round trip.
  bulkFetchConcurrency: intFromEnv('BULK_FETCH_CONCURRENCY', 1),
  // Memory ceiling for those transfers, split evenly. An instance also holds one 64 MiB multipart
  // upload buffer (src/storage/minio.js).
  bulkFetchBufferBytes: intFromEnv('BULK_FETCH_BUFFER_BYTES', 268435456),
  // The abuse boundary: APIM Consumption cannot key-limit an anonymous caller.
  bulkMaxPending:       intFromEnv('BULK_MAX_PENDING', 3),
  // bulkMaxPending bounds concurrency only; this bounds jobs started per 24 hours.
  bulkMaxPerDay:        intFromEnv('BULK_MAX_PER_DAY', 20),
  // The job carries the caller's roles from submit time, so an older job is refused rather than
  // run on unchecked credentials.
  bulkMaxJobAgeMs:      intFromEnv('BULK_MAX_JOB_AGE_MS', 7_200_000),
  // A `running` job older than this reads as failed. Taken from host.json so it cannot drift from
  // the queue's visibility timeout.
  bulkStaleRunningMs:   timeSpanMs(require('../host.json').extensions.queues.visibilityTimeout),
  bulkZipRetentionDays: intFromEnv('BULK_ZIP_RETENTION_DAYS', 7),
  bulkJobTtlDays:       intFromEnv('BULK_JOB_TTL_DAYS', 30),
  // Empty is off: Azure drops an app setting whose value is '', so unset must mean disabled, not
  // a fallback queue nothing is bound to.
  bulkDownloadsQueue:   process.env.BULK_DOWNLOADS_QUEUE || '',
  bulkCleanupSchedule:  process.env.BULK_CLEANUP_SCHEDULE || '',

  // Empty is off: the re-stamp is skipped, not done inline, unless chunkRestampInline is set.
  chunkRestampQueue:    process.env.CHUNK_RESTAMP_QUEUE || '',

  // Empty is off: the apply route answers 503; use docs/runbook-search-outage.md instead.
  searchDefinitionsQueue: process.env.SEARCH_DEFINITIONS_QUEUE || '',
  // Local `func start` only. Opt-in, not a fallback: a deployed walk would block eagle-api's
  // 10-second push. A skipped re-stamp flags the row for backfill-chunk-parent-fields.js.
  chunkRestampInline:   process.env.CHUNK_RESTAMP_INLINE === '1',

  uploadDir:             process.env.UPLOAD_DIRECTORY || '/tmp',

  logLevel:              process.env.LOG_LEVEL || 'info',

  // Search summary (wiki ADR-006), keyless via managed identity. Off by default: every caller gets
  // `{ summary: null }`.
  summaryEnabled:    process.env.SUMMARY_ENABLED === 'true',
  foundryEndpoint:   process.env.FOUNDRY_ENDPOINT || '',
  foundryDeployment: process.env.FOUNDRY_DEPLOYMENT || '',
  foundryApiVersion: process.env.FOUNDRY_API_VERSION || '2024-10-21',

  // Cost ceiling, enforced before the request: 8 x 1500 chars is about 3k input tokens. Cost grows
  // linearly with either; the probe asserts p95 prompt_tokens stays under that.
  summaryMaxChunks:  parseInt(process.env.SUMMARY_MAX_CHUNKS || '8', 10),
  summaryMaxChars:   parseInt(process.env.SUMMARY_MAX_CHARS  || '1500', 10),
  summaryMaxTokens:  parseInt(process.env.SUMMARY_MAX_TOKENS || '400', 10),
  // A timeout renders no panel and must never take the search results down with it.
  summaryTimeoutMs:  parseInt(process.env.SUMMARY_TIMEOUT_MS || '20000', 10),

  // CAD per million tokens, an estimate. Must match the model and SKU in foundry.bicep (regional
  // canadaeast meters); a change there makes every shown cost wrong.
  summaryCostPerMTokIn:  parseFloat(process.env.SUMMARY_COST_PER_MTOK_IN  || '0.70'),
  summaryCostPerMTokOut: parseFloat(process.env.SUMMARY_COST_PER_MTOK_OUT || '2.70'),

  // Stored project summaries read hundreds of chunks once per project, offline, so they get their own ceilings.
  projectSummaryMaxChunks: parseInt(process.env.PROJECT_SUMMARY_MAX_CHUNKS || '120', 10),
  projectSummaryMaxTokens: parseInt(process.env.PROJECT_SUMMARY_MAX_TOKENS || '1500', 10),
  // Bounds the reply, not the prompt: a list the model stops midway parses as nothing.
  projectSummaryBatchChunks: parseInt(process.env.PROJECT_SUMMARY_BATCH_CHUNKS || '16', 10),
  // Keyword hits across the project. Names repeat, so a larger set costs prompt and adds no nation.
  projectSummaryNationChunks: parseInt(process.env.PROJECT_SUMMARY_NATION_CHUNKS || '40', 10),
  // Per-document cap, so one roster-like document cannot fill the set and cite nations never
  // consulted on the project.
  projectSummaryNationChunksPerDoc:
    parseInt(process.env.PROJECT_SUMMARY_NATION_CHUNKS_PER_DOC || '4', 10),

  // Source for the `federal` section when DEMI holds no Decision Statement: `iaac` reads the public
  // registry (src/ai/federal-source.js), `off` is the kill switch.
  federalSource: process.env.FEDERAL_SOURCE || 'iaac',

  // `foundry` deployed, `ollama` local on the LAN. Cost is always priced at Foundry rates so local
  // and deployed records compare.
  projectSummaryProvider: process.env.PROJECT_SUMMARY_PROVIDER || 'foundry',
  // A LAN address, not a secret: Ollama has no auth and no deployed environment can reach it.
  ollamaUrl:   process.env.OLLAMA_URL || 'http://192.168.3.8:11434',
  ollamaModel: process.env.OLLAMA_MODEL || 'qwen3.6:35b-a3b',
  // Must be set: Ollama's 4k default truncates the prompt silently and still reports success.
  projectSummaryOllamaCtx: parseInt(process.env.PROJECT_SUMMARY_OLLAMA_CTX || '65536', 10),

  // Keyless. Empty is off, never an error: an audit call must not fail a request. Audit and
  // events are separate DCRs; the events pair falls back to the audit one.
  auditDcrEndpoint:    process.env.AUDIT_DCR_ENDPOINT || '',
  auditDcrImmutableId: process.env.AUDIT_DCR_IMMUTABLE_ID || '',
  // Must match the DCR: analytics takes only Custom-EagleAudit_CL, DEMI's only Custom-DemiAudit_CL;
  // a mismatch is dropped silently at ingest.
  auditStream:         process.env.AUDIT_STREAM_NAME || 'Custom-DemiAudit_CL',
  eventsDcrEndpoint:    process.env.EVENTS_DCR_ENDPOINT || process.env.AUDIT_DCR_ENDPOINT || '',
  eventsDcrImmutableId: process.env.EVENTS_DCR_IMMUTABLE_ID || process.env.AUDIT_DCR_IMMUTABLE_ID || '',
  // Flush on whichever fires first. 800 KB leaves room for the envelope under the 1 MB call limit.
  auditFlushMs:        parseInt(process.env.AUDIT_FLUSH_MS || '1000', 10),
  auditMaxBatch:       parseInt(process.env.AUDIT_MAX_BATCH || '100', 10),
  auditMaxBatchBytes:  parseInt(process.env.AUDIT_MAX_BATCH_BYTES || '800000', 10),

  // Workspace GUIDs (`customerId`), not resource ids. Empty is off: the route answers 503.
  auditWorkspaceCustomerId:   process.env.AUDIT_WORKSPACE_CUSTOMER_ID || '',
  appLogsWorkspaceCustomerId: process.env.APP_LOGS_WORKSPACE_CUSTOMER_ID || '',
  // `analytics-logs-<env>`, holding EagleAudit_CL. Empty keeps GET /admin/audit on DemiAudit_CL.
  analyticsWorkspaceCustomerId: process.env.ANALYTICS_WORKSPACE_CUSTOMER_ID || '',
  // Resource group id: the scope a cost query and the budget are both read at.
  costScope:                  process.env.COST_SCOPE || '',
  budgetName:                 process.env.BUDGET_NAME || '',

  // A getter: compared per request, and tests set the variable after this file loads.
  get adminApiKey() { return secretFromEnv('ADMIN_API_KEY'); },

  keycloakUrl:           process.env.KEYCLOAK_URL || 'https://dev.loginproxy.gov.bc.ca/auth',
  keycloakRealm:         process.env.KEYCLOAK_REALM || 'eao-epic',
  keycloakClientId:      process.env.KEYCLOAK_CLIENT_ID || 'eagle-admin-console',
  keycloakEnabled:       process.env.KEYCLOAK_ENABLED !== 'false',
  // The realm URL a client-credentials token is minted at (services/keycloak-client-token.js).
  get keycloakIssuer() { return `${config.keycloakUrl.replace(/\/+$/, '')}/realms/${config.keycloakRealm}`; },
  // Only ENVIRONMENT, the name api-function-flex.bicep sets. The tag it puts on minted keys is
  // cosmetic; nothing authorises on it.
  environmentName:       process.env.ENVIRONMENT || 'dev',
  // Keycloak clients (azp) allowed at all. Empty admits every client; see the boot guard below.
  allowedClients:        (process.env.DEMI_ALLOWED_CLIENTS || '').split(',').map(s => s.trim()).filter(Boolean),
  // Registry row ids for PUT /eagle/*. Unset means eagle-api through APIM; set but empty means
  // nobody, so blanking the setting closes the mirror.
  get eagleMirrorPrincipals() { return principalsFromEnv('DEMI_EAGLE_MIRROR_PRINCIPALS', 'apim:eagle-api'); },
  // No default: these routes sign writes to stored originals. Never share a principal with
  // another list, or one key holds both powers.
  get pdfTitleWorkerPrincipals() { return principalsFromEnv('DEMI_PDF_TITLE_WORKER_PRINCIPALS'); },
  // PUT /engage/*. Same rules as the Eagle mirror list.
  get engagePrincipals() { return principalsFromEnv('DEMI_ENGAGE_PRINCIPALS', 'apim:engage'); },
  // The Track push. Same rules as the Eagle mirror list.
  get trackPrincipals() { return principalsFromEnv('DEMI_TRACK_PRINCIPALS', 'apim:track'); },
  // Short links: destinations are allowlisted by hostname suffix at write time (helpers/link-url).
  // linkBaseUrl is a Bicep app setting per environment so test hands back the test host, not prod's.
  linkAllowedHosts:      (process.env.LINK_ALLOWED_HOSTS || 'gov.bc.ca').split(',').map(s => s.trim()).filter(Boolean),
  linkBaseUrl:           process.env.LINK_BASE_URL || 'https://projects.eao.gov.bc.ca',

  // Both empty: nothing is sent and no notification is claimed, so wiring it later still notifies.
  notifyApiBase:         process.env.NOTIFY_API_BASE || '',
  notifyApiKey:          secretFromEnv('NOTIFY_API_KEY'),
  // On: an update email links eagle-public's reader page `/updates/<id>`. Only the React line has
  // that route, so it stays off wherever linkBaseUrl still serves the Angular site.
  notifyUpdateReaderLinks: process.env.NOTIFY_UPDATE_READER_LINKS === 'true',
  // On until src/scripts/backfill-update-publish-date.js reports no undated row: a sort on an
  // Update's publishDate runs on dateAdded, since an ORDER BY leaves out rows without its field.
  updatesPublishDateFallback: process.env.UPDATES_PUBLISH_DATE_FALLBACK !== 'false',

  // Getters so tests can change them after load. Empty queue is off: enqueue refuses and no worker
  // is bound.
  syncOut: {
    get queue() { return envTrim('SYNC_OUT_QUEUE'); },
    eagle: {
      get enabled() { return envTrim('SYNC_OUT_EAGLE_ENABLED') === 'true'; },
      // On only once eagle-api's POST keeps the `_id` DEMI sends and answers a duplicate with 409,
      // or every native create lands as a stray.
      get nativeEnabled() { return envTrim('SYNC_OUT_EAGLE_NATIVE_ENABLED') === 'true'; },
      // Each kind goes to Eagle only with its own switch on as well, so registering a kind does not send it.
      get documentEnabled() { return envTrim('SYNC_OUT_EAGLE_DOCUMENT_ENABLED') === 'true'; },
      get organizationEnabled() { return envTrim('SYNC_OUT_EAGLE_ORGANIZATION_ENABLED') === 'true'; },
      get projectEnabled() { return envTrim('SYNC_OUT_EAGLE_PROJECT_ENABLED') === 'true'; },
      get updateEnabled() { return envTrim('SYNC_OUT_EAGLE_UPDATE_ENABLED') === 'true'; },
      get notificationEnabled() { return envTrim('SYNC_OUT_EAGLE_NOTIFICATION_ENABLED') === 'true'; },
      get commentEnabled() { return envTrim('SYNC_OUT_EAGLE_COMMENT_ENABLED') === 'true'; },
      // eagle-api's protected `/api`, not EAGLE_API_BASE: that one is the public base the seed reads.
      get apiBase() { return envTrim('EAGLE_PROTECTED_API_BASE').replace(/\/+$/, ''); },
      // The realm eagle-api trusts is DEMI's own, so the issuer comes from KEYCLOAK_URL and KEYCLOAK_REALM.
      get issuer() { return config.keycloakIssuer; },
      get clientId() { return envTrim('EAGLE_KC_CLIENT_ID'); },
      get clientSecret() { return secretFromEnv('EAGLE_KC_CLIENT_SECRET').trim(); },
      get milestone() { return envTrim('EAGLE_ENGAGE_MILESTONE'); }
    }
  },
  // ENGAGE's public API, read by both reconcile scripts. Empty skips their ENGAGE side.
  engageApiBase:           process.env.ENGAGE_API_BASE || '',
  // Empty registers no reconcileEngage timer. A getter: the trigger suites reload api/index.js per value.
  get reconcileEngageSchedule() { return envTrim('RECONCILE_ENGAGE_SCHEDULE'); },

  // Two client-credentials identities: one reads Track, one holds `realm-management`.
  trackApiBase:              process.env.TRACK_API_BASE || '',
  trackClientId:             process.env.TRACK_CLIENT_ID || '',
  trackClientSecret:         secretFromEnv('TRACK_CLIENT_SECRET'),
  trackWorksSync:            process.env.TRACK_WORKS_SYNC === 'true',
  worksWrite:                process.env.WORKS_WRITE === 'true',
  worksRead:                 process.env.WORKS_READ === 'true',
  worksReadSources:          [...new Set((envTrim('WORKS_READ_SOURCES') || 'track').toLowerCase().split(/\s*,\s*/))],
  assessmentPass:            process.env.ASSESSMENT_PASS === 'true',
  keycloakAdminClientId:     process.env.KEYCLOAK_ADMIN_CLIENT_ID || '',
  keycloakAdminClientSecret: secretFromEnv('KEYCLOAK_ADMIN_CLIENT_SECRET'),

  ssoJwksUri:            process.env.SSO_JWKSURI || `${process.env.KEYCLOAK_URL || 'https://dev.loginproxy.gov.bc.ca/auth'}/realms/${process.env.KEYCLOAK_REALM || 'eao-epic'}/protocol/openid-connect/certs`,
  ssoIssuer:             process.env.SSO_ISSUER || `${process.env.KEYCLOAK_URL || 'https://dev.loginproxy.gov.bc.ca/auth'}/realms/${process.env.KEYCLOAK_REALM || 'eao-epic'}`,
  // Empty is not enforced. No default: a wrong audience 401s every caller.
  ssoAudience:           process.env.SSO_AUDIENCE || '',

  // Proxy egress addresses. Behind one, every visitor shares an address, so utils/caller-ip.js keys
  // the anonymous quota on the browser hop instead.
  trustedProxyIps:       proxyListFromEnv('TRUSTED_PROXY_IPS'),

  // Front Door stamps this as X-Edge-Secret; it is the only reason X-Azure-SocketIP is believed.
  // Empty ignores the header until an EDGE_SECRET_URI read succeeds.
  edgeSecret:            secretFromEnv('EDGE_SECRET'),

  // Read with `-standby` so a rotation lands without a deploy. Empty: plain settings only.
  edgeSecretUri:         vaultSecretUriFromEnv('EDGE_SECRET_URI'),
  apimGatewaySecretUri:  vaultSecretUriFromEnv('APIM_GATEWAY_SECRET_URI'),

  // Requests that skipped Front Door: '' serves, 'log' serves and warns, 'enforce' answers 403.
  edgeGate:              (process.env.EDGE_GATE || '').trim().toLowerCase(),

  // Getters that throw on read, not at load: a bad value fails one timer tick, not the HTTP API.
  edgeBan: {
    // off clears the ban rule, shadow records would-bans only, write records and updates the rule.
    get mode() {
      const mode = envTrim('EDGE_BAN_MODE').toLowerCase();
      if (mode && !EDGE_BAN_MODES.includes(mode)) {
        throw new Error(`EDGE_BAN_MODE must be one of ${EDGE_BAN_MODES.join(', ')}, got '${mode}'.`);
      }
      return mode;
    },
    // NCRONTAB, six fields. Hourly when unset.
    get schedule() { return envTrim('EDGE_BAN_SCHEDULE') || '0 0 * * * *'; },
    // null when unset or unresolved. Errors never quote the value or the parser message.
    get policy() {
      const raw = secretFromEnv('EDGE_BAN_POLICY').trim();
      if (!raw) return null;
      let policy;
      try { policy = JSON.parse(raw); } catch { throw new Error('EDGE_BAN_POLICY is not valid JSON.'); }
      if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
        throw new Error('EDGE_BAN_POLICY must be a JSON object.');
      }
      return policy;
    },
    // Front Door access log workspace and the `banauto` rule id, both in the eagle-edge group.
    get workspaceId() { return envTrim('EDGE_LOG_WORKSPACE_ID'); },
    get ruleId() { return envTrim('EDGE_BAN_RULE_ID'); }
  },

  // Defender tags each upload; the sweep releases or quarantines by tag. Empty storageAccount
  // registers no intake function.
  intake: {
    get storageAccount() { return envTrim('INTAKE_STORAGE_ACCOUNT'); },
    get incomingContainer() { return envTrim('INTAKE_INCOMING_CONTAINER') || 'incoming'; },
    get quarantineContainer() { return envTrim('INTAKE_QUARANTINE_CONTAINER') || 'quarantine'; },
    // Client id of the second managed identity, the only one allowed to read a file not tagged clean.
    get quarantineClientId() { return envTrim('INTAKE_QUARANTINE_CLIENT_ID'); },
    // NCRONTAB, six fields. Every 5 minutes when unset: a scan result waits up to one tick.
    get sweepSchedule() { return envTrim('INTAKE_SWEEP_SCHEDULE') || '0 */5 * * * *'; },
    // Defender's monthly scan cap in GB, logged beside the month's scanned bytes. 0 = unset.
    get capGBPerMonth() { return intFromEnv('INTAKE_CAP_GB_PER_MONTH', 0); },
    // Scanning takes up to 3 hours, so a timeout here is final.
    get pendingTimeoutHours() { return intFromEnv('INTAKE_PENDING_TIMEOUT_HOURS', 6); }
  },
};

// For backfill-objects.js: the test credentials cannot read the prod bucket. Host and port
// default to the target's, since both buckets sit on one host.
config.sourceMinioAccess = secretFromEnv('SOURCE_MINIO_ACCESS_KEY');
config.sourceMinioSecret = secretFromEnv('SOURCE_MINIO_SECRET_KEY');
config.sourceMinioHost = process.env.SOURCE_MINIO_HOST || config.minioHost;
config.sourceMinioPort = intFromEnv('SOURCE_MINIO_PORT', config.minioPort);
config.sourceMinioSsl = process.env.SOURCE_MINIO_USE_SSL
  ? process.env.SOURCE_MINIO_USE_SSL === 'true' : config.minioSsl;

// Only dev and local may admit every client, so an unknown ENVIRONMENT name counts as deployed.
if (config.environmentName !== 'dev' && config.environmentName !== 'local' &&
    config.allowedClients.length === 0) {
  throw new Error(
    `DEMI_ALLOWED_CLIENTS must name at least one Keycloak client in ${config.environmentName}.`
  );
}

// A typo in EDGE_GATE would otherwise switch the gate off without a word.
if (!EDGE_GATE_MODES.includes(config.edgeGate)) {
  throw new Error(`EDGE_GATE must be empty, 'log' or 'enforce', got '${config.edgeGate}'.`);
}

// A typo would otherwise hide that source's works without a word.
const badSource = config.worksReadSources.find(source => !['track', 'sheet', 'demi'].includes(source));
if (badSource !== undefined) throw new Error(`WORKS_READ_SOURCES: '${badSource}' is not track, sheet or demi.`);

// With Keycloak off every Bearer token is refused, so a deployed API would serve no signed-in user.
if ((config.environmentName === 'test' || config.environmentName === 'prod') && !config.keycloakEnabled) {
  throw new Error(`KEYCLOAK_ENABLED cannot be false in ${config.environmentName}.`);
}

// Read once at load so an unresolved ADMIN_API_KEY makes the boot report; the value is discarded.
secretFromEnv('ADMIN_API_KEY');

// Read by src/utils/rotating-secret.js, which takes APIM_GATEWAY_SECRET per request.
config.secretFromEnv = secretFromEnv;
// Which settings came back as an unresolved reference. src/utils/logger.js reports the names.
config.unresolvedSecrets = unresolvedSecrets;

module.exports = config;
