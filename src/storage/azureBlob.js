'use strict';

/**
 * Azure Blob Storage backend — keyless, per-environment container.
 *
 * Two differences from the MinIO backend are deliberate, not incidental:
 *
 *   1. **No key prefix.** MinIO needs one because every environment's bucket contains a nested
 *      copy of prod. Here each environment gets its OWN container, so the recorded `s3Key` is
 *      the blob name verbatim. That is the actual safety improvement: dev is one env-var edit
 *      from prod storage today, and separate containers make that structurally impossible.
 *
 *   2. **The container is never created on demand.** A user delegation SAS requires the
 *      container to already exist, and auto-creating one would mean a typo in configuration
 *      silently produces a working-but-empty store instead of an error. Containers come from
 *      Bicep.
 *
 * Auth is Entra managed identity — `allowSharedKeyAccess: false` on the account, so there is no
 * key to leak or rotate. Download URLs are **user delegation SAS**, signed with a key obtained
 * from the identity rather than an account key. That requires the identity to hold both
 * `Storage Blob Data Contributor` and `Storage Blob Delegator`.
 */

const {
  BlobServiceClient,
  BlobSASPermissions,
  SASProtocol,
  generateBlobSASQueryParameters
} = require('@azure/storage-blob');
const { DefaultAzureCredential } = require('@azure/identity');

const config = require('../config');
const { contentDisposition } = require('./content-disposition');

/** Delegation keys are valid up to 7 days. Re-fetching per request would add a round trip to
 *  every download, so it is cached — but well short of the maximum, because an expired key
 *  produces SAS URLs that fail authentication rather than an obvious error.
 *  ponytail: fixed 30 min. Only worth tuning if delegation-key calls show up in latency. */
const DELEGATION_KEY_TTL_MS = 30 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

let serviceClient;
let cachedKey = null; // { key, expiresAt }

function requireConfig() {
  if (!config.azureStorageAccount) {
    throw new Error(
      '[storage] AZURE_STORAGE_ACCOUNT is required when STORAGE_BACKEND=azure'
    );
  }
  if (!config.azureStorageContainer) {
    throw new Error(
      '[storage] AZURE_STORAGE_CONTAINER is required when STORAGE_BACKEND=azure'
    );
  }
}

function getServiceClient() {
  if (!serviceClient) {
    requireConfig();
    serviceClient = new BlobServiceClient(
      `https://${config.azureStorageAccount}.blob.core.windows.net`,
      new DefaultAzureCredential()
    );
  }
  return serviceClient;
}

function getBlobClient(key) {
  if (!key) throw new Error('[storage] a blob name is required');
  return getServiceClient()
    .getContainerClient(config.azureStorageContainer)
    .getBlockBlobClient(key);
}

async function getBuffer(key) {
  return getBlobClient(key).downloadToBuffer();
}

/** The un-draining half of getBuffer: for objects too big to hold in memory. */
async function getObjectStream(key) {
  const res = await getBlobClient(key).download();
  return res.readableStreamBody;
}

/**
 * A time-limited user delegation key, cached.
 *
 * `now` is injectable so the cache expiry is testable without waiting 30 minutes.
 */
async function getDelegationKey(now = Date.now()) {
  if (cachedKey && cachedKey.expiresAt > now) return cachedKey.key;

  // Start slightly in the past: a few seconds of clock skew between this host and the storage
  // service would otherwise reject a key that is valid from "now".
  const startsOn = new Date(now - CLOCK_SKEW_MS);
  const expiresOn = new Date(now + DELEGATION_KEY_TTL_MS + CLOCK_SKEW_MS);

  const key = await getServiceClient().getUserDelegationKey(startsOn, expiresOn);
  cachedKey = { key, expiresAt: now + DELEGATION_KEY_TTL_MS };
  return key;
}

async function getDownloadUrl(key, opts = {}) {
  const expirySeconds = opts.expirySeconds || 300;
  const now = opts.now || Date.now();
  const blobClient = getBlobClient(key);
  const delegationKey = await getDelegationKey(now);

  const sasOptions = {
    containerName: config.azureStorageContainer,
    blobName: key,
    // Read only. A download link must never carry write or delete rights — a leaked URL with
    // `d` would let anyone destroy a source document.
    permissions: BlobSASPermissions.parse('r'),
    protocol: SASProtocol.Https,
    startsOn: new Date(now - CLOCK_SKEW_MS),
    expiresOn: new Date(now + expirySeconds * 1000)
  };

  if (opts.fileName) {
    sasOptions.contentDisposition = contentDisposition(opts.fileName);
  }

  const sas = generateBlobSASQueryParameters(
    sasOptions, delegationKey, config.azureStorageAccount
  ).toString();

  return `${blobClient.url}?${sas}`;
}

async function putFile(key, filePath, contentType) {
  const blobClient = getBlobClient(key);
  await blobClient.uploadFile(filePath, {
    blobHTTPHeaders: contentType ? { blobContentType: contentType } : undefined
  });
  return key;
}

/** Store a readable stream of unknown length: 4 MiB blocks, 5 uploaded concurrently. */
async function putObjectStream(key, stream, contentType) {
  await getBlobClient(key).uploadStream(stream, 4 * 1024 * 1024, 5, {
    blobHTTPHeaders: contentType ? { blobContentType: contentType } : undefined
  });
  return key;
}

/** Delete an object. `deleteIfExists` swallows the 404, which is what a re-running sweep needs. */
async function removeObject(key) {
  await getBlobClient(key).deleteIfExists();
}

function describe() {
  return {
    backend: 'azure',
    account: config.azureStorageAccount || null,
    container: config.azureStorageContainer || null,
    keyPrefix: null
  };
}

/** Test seam — the delegation-key cache is module state. */
function _resetCache() {
  serviceClient = undefined;
  cachedKey = null;
}

module.exports = {
  getBuffer,
  getObjectStream,
  getDownloadUrl,
  putFile,
  putObjectStream,
  removeObject,
  describe,
  getDelegationKey,
  DELEGATION_KEY_TTL_MS,
  _resetCache
};
