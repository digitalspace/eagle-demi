'use strict';

/**
 * MinIO / S3 storage backend. Moved out of `extract.js`, which is a batch script that the HTTP
 * controllers were reaching into purely to borrow its client.
 *
 * This backend owns the object-key prefix. The prefix exists because the recorded `s3Key` is
 * relative to the PROD bucket, while non-prod buckets hold a copy of prod nested one level
 * deeper (dev's bucket `asnpnn` contains `ozwdez/etl/...`). Applying it here rather than at each
 * call site is the point: `extract.js` forgot to, so every extraction read a key that 404s in
 * dev — the same bug the download endpoint already had.
 */

const Minio = require('minio');
const config = require('../config');
const { resolveObjectKey } = require('./objectKey');
const { contentDisposition } = require('./content-disposition');

// Multipart part size for a stream of unknown length. Without a hint the SDK falls back to the
// size that lets a 5 TB object fit in 10,000 parts — 528 MiB — and BUFFERS each part in memory,
// which a 2048 MB Functions instance cannot hold. host.json's queue budget assumes this number.
const UPLOAD_PART_SIZE = 64 * 1024 * 1024;

let client;

function getClient() {
  if (!client) {
    client = new Minio.Client({
      endPoint: config.minioHost,
      port: config.minioPort,
      useSSL: config.minioSsl,
      accessKey: config.minioAccess,
      secretKey: config.minioSecret,
      // Explicit region avoids a blocking bucket-region lookup on every presign. Without it
      // the SDK hangs ~135 s from Azure before failing, since MinIO is on OpenShift Silver.
      region: config.minioRegion,
      partSize: UPLOAD_PART_SIZE
    });
  }
  return client;
}

async function getBuffer(key) {
  const objectPath = resolveObjectKey(key);
  const stream = await getClient().getObject(config.minioBucket, objectPath);

  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** The un-draining half of getBuffer: for objects too big to hold in memory. */
async function getObjectStream(key) {
  return getClient().getObject(config.minioBucket, resolveObjectKey(key));
}

async function getDownloadUrl(key, opts = {}) {
  const expirySeconds = opts.expirySeconds || 300;
  // The response headers are part of what is signed.
  const respHeaders = opts.fileName
    ? { 'response-content-disposition': contentDisposition(opts.fileName) }
    : undefined;
  return getClient().presignedGetObject(
    config.minioBucket, resolveObjectKey(key), expirySeconds, respHeaders
  );
}

async function putFile(key, filePath, contentType) {
  const objectPath = resolveObjectKey(key);
  const meta = contentType ? { 'Content-Type': contentType } : undefined;

  // The bucket is created on demand because uploads are the only writer and a fresh
  // environment has no bucket. Azure Blob deliberately does NOT do this — see azureBlob.js.
  if (!(await getClient().bucketExists(config.minioBucket))) {
    await getClient().makeBucket(config.minioBucket, config.minioRegion);
  }
  await getClient().fPutObject(config.minioBucket, objectPath, filePath, meta);
  return objectPath;
}

/**
 * Store a readable stream of UNKNOWN length under `key`.
 *
 * The size argument is omitted deliberately: nobody has a byte count while a zip is still being
 * written, and a wrong one truncates the object. The client's `partSize` is what bounds memory.
 */
async function putObjectStream(key, stream, contentType) {
  const objectPath = resolveObjectKey(key);
  const meta = contentType ? { 'Content-Type': contentType } : undefined;
  await getClient().putObject(config.minioBucket, objectPath, stream, undefined, meta);
  return objectPath;
}

/** Delete an object. Already gone is success: cleanup re-runs over keys a retry may have removed. */
async function removeObject(key) {
  try {
    return await getClient().removeObject(config.minioBucket, resolveObjectKey(key));
  } catch (err) {
    if (err && (err.code === 'NoSuchKey' || err.code === 'NotFound' || err.statusCode === 404)) {
      return undefined;
    }
    throw err;
  }
}

function describe() {
  return {
    backend: 'minio',
    host: config.minioHost,
    bucket: config.minioBucket,
    keyPrefix: config.minioKeyPrefix || null
  };
}

module.exports = {
  getBuffer, getObjectStream, getDownloadUrl, putFile, putObjectStream, removeObject, describe
};
