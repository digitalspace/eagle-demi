'use strict';

const clients = new Map();

/**
 * Identity-based, no connection string; memoised because a new client re-runs the credential chain.
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
    const { createCredential } = require('../utils/azure-credential');
    clients.set(url, new QueueClient(url, createCredential()));
  }
  return clients.get(url);
}

module.exports = { queueClientFor };
