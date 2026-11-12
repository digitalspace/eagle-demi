'use strict';

/**
 * One-way MinIO -> Azure Blob copy, dry run unless `--live`. The source is only read, never written;
 * keys already present at equal size are skipped, so a rerun resumes.
 */

const fs = require('fs');
const config = require('../config');

// Imported by name so the write path of the SOURCE backend is not even in scope.
const { getBuffer: readFromMinio } = require('../storage/minio');
const azure = require('../storage/azureBlob');
const { BlobServiceClient } = require('@azure/storage-blob');
const { createCredential } = require('../utils/azure-credential');
const { mapLimit } = require('../utils/worker-pool');

function parseArgs(argv) {
  const args = { live: false, concurrency: 8, limit: Infinity, keysFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (a === '--keys-file') args.keysFile = argv[++i];
    else if (a === '--concurrency') args.concurrency = parseInt(argv[++i], 10);
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
  }
  return args;
}

function loadKeys(keysFile, limit) {
  const raw = fs.readFileSync(keysFile, 'utf8');
  const keys = raw.split('\n').map(k => k.trim()).filter(Boolean);
  const unique = Array.from(new Set(keys));
  if (unique.length !== keys.length) {
    console.log(`  (${keys.length - unique.length} duplicate keys collapsed)`);
  }
  return unique.slice(0, limit);
}

/**
 * Not reused from azureBlob.js: this needs container `exists()` and `getProperties()`, which the
 * storage interface does not expose.
 */
function getContainerClient() {
  return new BlobServiceClient(
    `https://${config.azureStorageAccount}.blob.core.windows.net`,
    createCredential()
  ).getContainerClient(config.azureStorageContainer);
}

/**
 * Returns `{status: 'copied'|'skipped', bytes}`. The size check makes resume safe: a blob truncated
 * by an interrupted upload is recopied.
 */
async function copyOne(containerClient, key, live) {
  const blobClient = containerClient.getBlockBlobClient(key);

  const buffer = await readFromMinio(key);

  let existingSize = null;
  try {
    existingSize = (await blobClient.getProperties()).contentLength;
  } catch (err) {
    if (err.statusCode !== 404) throw err;
  }

  if (existingSize === buffer.length) return { status: 'skipped', bytes: 0 };

  // Dry run: report what would happen, write nothing.
  if (!live) return { status: 'copied', bytes: buffer.length };

  await blobClient.uploadData(buffer);

  // Verify rather than trust: a silent short write would leave an unreadable document that
  // still looks present in the metadata.
  const written = (await blobClient.getProperties()).contentLength;
  if (written !== buffer.length) {
    throw new Error(`size mismatch after upload: wrote ${written}, expected ${buffer.length}`);
  }
  return { status: 'copied', bytes: buffer.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.keysFile) {
    console.error('--keys-file is required (newline-delimited s3Key values)');
    process.exit(1);
  }
  if (!config.azureStorageAccount || !config.azureStorageContainer) {
    console.error('AZURE_STORAGE_ACCOUNT and AZURE_STORAGE_CONTAINER must be set');
    process.exit(1);
  }
  if (!config.minioHost || config.minioHost === 'localhost') {
    console.error('MINIO_HOST is unset or localhost — refusing to run against a default source');
    process.exit(1);
  }

  const keys = loadKeys(args.keysFile, args.limit);

  console.log('Source (READ ONLY):', JSON.stringify({
    host: config.minioHost, bucket: config.minioBucket,
    keyPrefix: config.minioKeyPrefix || null
  }));
  console.log('Destination:', JSON.stringify(azure.describe()));
  console.log(`Keys: ${keys.length} · concurrency ${args.concurrency} · ` +
    `${args.live ? 'LIVE' : 'DRY RUN (nothing will be written)'}`);

  const containerClient = getContainerClient();
  if (!(await containerClient.exists())) {
    // Never created here: the container comes from Bicep, and auto-creating one would turn a
    // typo in configuration into a working-but-empty destination.
    console.error(
      `Container "${config.azureStorageContainer}" does not exist. Deploy ` +
      'azure/modules/document-storage.bicep first.'
    );
    process.exit(1);
  }

  const counts = { copied: 0, skipped: 0, failed: 0 };
  const failures = [];
  let bytes = 0;

  await mapLimit(keys, args.concurrency, async (key, i) => {
    try {
      const result = await copyOne(containerClient, key, args.live);
      counts[result.status]++;
      bytes += result.bytes;
    } catch (err) {
      counts.failed++;
      if (failures.length < 50) failures.push({ key, error: err.message });
    }
    if ((i + 1) % 500 === 0) {
      console.log(`  ${i + 1}/${keys.length} — copied ${counts.copied}, ` +
        `skipped ${counts.skipped}, failed ${counts.failed}`);
    }
  });

  console.log(`\nDone. copied=${counts.copied} skipped=${counts.skipped} failed=${counts.failed}`);
  if (bytes) {
    console.log(`${args.live ? 'Transferred' : 'Would transfer'} ~${(bytes / 1e9).toFixed(1)} GB`);
  }

  if (failures.length) {
    console.log('\nFirst failures:');
    for (const f of failures) console.log(`  ${f.key}: ${f.error}`);
  }
  // A partial copy must not look like a success to a CI step or a wrapper script.
  if (counts.failed > 0) process.exitCode = 1;
}

module.exports = { parseArgs, loadKeys, copyOne };

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
