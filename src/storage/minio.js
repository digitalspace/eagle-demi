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
      region: config.minioRegion
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

async function getDownloadUrl(key, opts = {}) {
  const expirySeconds = opts.expirySeconds || 300;
  return getClient().presignedGetObject(
    config.minioBucket, resolveObjectKey(key), expirySeconds
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

function describe() {
  return {
    backend: 'minio',
    host: config.minioHost,
    bucket: config.minioBucket,
    keyPrefix: config.minioKeyPrefix || null
  };
}

module.exports = { getBuffer, getDownloadUrl, putFile, describe };
