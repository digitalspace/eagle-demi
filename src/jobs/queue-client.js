'use strict';

const clients = new Map();

/**
 * The one way this app reaches a storage queue.
 *
 * Identity-based against the account the Functions host uses for `AzureWebJobsStorage`
 * (`AzureWebJobsStorage__accountName`), so there is no connection string here and none is wanted.
 * Memoised per queue: building a `QueueClient` per send re-runs the credential chain.
 *
 * @param {object} queue `{name}` from config, `{setting}` the app setting that carries it and
 *                       `{feature}` what is off when it is missing.
 */
function queueClientFor({ name, setting, feature }) {
  if (!name) throw new Error(`${feature} is disabled: ${setting} is not set`);
  const account = process.env.AzureWebJobsStorage__accountName;
  if (!account) {
    throw new Error(`${feature} is disabled: AzureWebJobsStorage__accountName is not set`);
  }

  const url = `https://${account}.queue.core.windows.net/${name}`;
  if (!clients.has(url)) {
    const { QueueClient } = require('@azure/storage-queue');
    const { DefaultAzureCredential } = require('@azure/identity');
    // The client id is required when several user-assigned identities are attached — same reason
    // as src/db/cosmos-nosql.js.
    clients.set(url, new QueueClient(
      url, new DefaultAzureCredential({ managedIdentityClientId: process.env.AZURE_CLIENT_ID })
    ));
  }
  return clients.get(url);
}

module.exports = { queueClientFor };
