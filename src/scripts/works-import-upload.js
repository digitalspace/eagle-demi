'use strict';

const path = require('path');
const { createBlobClientFor } = require('../storage/azureBlob');

// The API storage account (api-function-flex.bicep): its 7-day delete rule covers works-import.
const STORAGE_ACCOUNT = /^demifc(test|prod)[a-z0-9]{13}$/;
const CONTAINER = 'works-import';

/** `--storage-account`, refused unless it is the demifc API storage account of `env`. */
function checkStorageAccount(account, env, refuse = (message) => { throw new Error(message); }) {
  if (STORAGE_ACCOUNT.exec(account)?.[1] !== env) refuse(`--storage-account must be the demifc${env} API storage account`);
  return account;
}

/** Uploads the sealed file `name` in `dir` to works-import under the same name, where the operator downloads it. */
function uploadSealed(account, dir, name) {
  return createBlobClientFor(account, { container: CONTAINER }).putFile(name, path.join(dir, name), 'application/json');
}

module.exports = { checkStorageAccount, uploadSealed };
