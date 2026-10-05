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
// The package's public signer: presignedPutObject cannot sign extra headers such as Content-MD5.
const { presignSignatureV4 } = require('minio/dist/main/signing.js');
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

/** A byte range of an object, or of one version of it. The facade checks key, offset and length. */
async function getRangeStream(key, offset, length, { versionId } = {}) {
  // The SDK reads to the end of the object when length is 0.
  if (!(length > 0)) throw new Error('[storage] a range read needs a length');
  return getClient().getPartialObject(config.minioBucket, resolveObjectKey(key), offset, length,
    versionId ? { versionId } : undefined);
}

async function getDownloadUrl(key, opts = {}) {
  const expirySeconds = opts.expirySeconds || 300;
  // The response headers are part of what is signed.
  const respHeaders = {};
  if (opts.fileName) {
    respHeaders['response-content-disposition'] =
      contentDisposition(opts.fileName, { inline: Boolean(opts.inlineType) });
  }
  if (opts.inlineType) respHeaders['response-content-type'] = opts.inlineType;
  return getClient().presignedGetObject(
    config.minioBucket, resolveObjectKey(key), expirySeconds, respHeaders
  );
}

/**
 * Presigned V4 PUT for one object, with Content-MD5 signed when given. The facade checks the key.
 * Content-Type is never signed: the SDK's signer drops it from SignedHeaders on purpose.
 */
async function getUploadUrl(key, { expirySeconds, contentMd5 } = {}) {
  // The SDK's own default is 7 days; a write link must never get that by omission.
  if (!(expirySeconds > 0)) throw new Error('[storage] an upload URL needs an expiry');
  const request = getClient().getRequestOptions({
    method: 'PUT', region: config.minioRegion, bucketName: config.minioBucket,
    objectName: resolveObjectKey(key), headers: contentMd5 ? { 'content-md5': contentMd5 } : undefined
  });
  return presignSignatureV4(request, config.minioAccess, config.minioSecret, undefined,
    config.minioRegion, new Date(), expirySeconds);
}

/** Server-side copy, refused by the store with 412 when the source etag has moved on. */
async function copyObject(src, dest, { ifSourceEtag }) {
  const res = await getClient().copyObject(
    new Minio.CopySourceOptions({
      Bucket: config.minioBucket, Object: resolveObjectKey(src), MatchETag: ifSourceEtag
    }),
    new Minio.CopyDestinationOptions({ Bucket: config.minioBucket, Object: resolveObjectKey(dest) })
  );
  return { etag: res.Etag || null, versionId: res.VersionId || null };
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

function isMissing(err) {
  return Boolean(err) && (err.code === 'NoSuchKey' || err.code === 'NotFound' || err.statusCode === 404);
}

/** Size and type of a stored object, or null when it is not there. */
async function statObject(key) {
  try {
    const stat = await getClient().statObject(config.minioBucket, resolveObjectKey(key));
    const meta = stat.metaData || {};
    return {
      size: stat.size, contentType: meta['content-type'] || null, etag: stat.etag || null,
      versionId: stat.versionId || null
    };
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/**
 * Delete an object, or one version of it. Already gone is success: cleanup re-runs over keys a
 * retry may have removed. In a versioned bucket only a versionId delete frees the bytes.
 */
async function removeObject(key, { versionId } = {}) {
  try {
    return await getClient().removeObject(config.minioBucket, resolveObjectKey(key),
      versionId ? { versionId } : undefined);
  } catch (err) {
    if (isMissing(err)) return undefined;
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
  getBuffer, getObjectStream, getRangeStream, getDownloadUrl, getUploadUrl, copyObject, statObject,
  putFile, putObjectStream, removeObject, describe
};
