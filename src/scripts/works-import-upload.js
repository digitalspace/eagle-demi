'use strict';

const path = require('path');
const azureBlob = require('../storage/azureBlob');
const { logger } = require('../utils/logger');

// The API storage account (api-function-flex.bicep): its 7-day delete rule covers works-import.
const STORAGE_ACCOUNT = /^demifc(test|prod)[a-z0-9]{13}$/;
const CONTAINER = 'works-import';

/** Refuses `--storage-account` unless it is the demifc API storage account of `env`. */
function checkStorageAccount(account, env, refuse = (message) => { throw new Error(message); }) {
  if (STORAGE_ACCOUNT.exec(account)?.[1] !== env) refuse(`--storage-account must be the demifc${env} API storage account`);
}

/**
 * Uploads the sealed file `name` in `dir` to works-import under the same name, where the operator downloads it.
 * A failure names the file, so the operator can still find the copy in `dir`.
 */
async function uploadSealed(account, dir, name) {
  try {
    await azureBlob.createBlobClientFor(account, { container: CONTAINER }).putFile(name, path.join(dir, name), 'application/json');
  } catch (err) {
    throw new Error(`upload of ${name} to ${CONTAINER} failed: ${err.message}`, { cause: err });
  }
  logger.info('[works-import] sealed file uploaded', { account, container: CONTAINER, blob: name });
}

module.exports = { checkStorageAccount, uploadSealed };
