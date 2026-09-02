'use strict';

/**
 * The bulk-download work queue — the only producer side.
 *
 * Identity-based, against the same account the Functions host uses for `AzureWebJobsStorage`
 * (`AzureWebJobsStorage__accountName`), so there is no connection string here and none is wanted.
 *
 * The message body is the bare job id, unencoded: `host.json` sets `messageEncoding: "none"`, and
 * base64 on this side would reach the trigger as a corrupt id.
 */

const { QueueClient } = require('@azure/storage-queue');
const { DefaultAzureCredential } = require('@azure/identity');

const config = require('../config');

let client;

function queueClient() {
  if (!config.bulkDownloadsQueue) {
    throw new Error('bulk download is disabled: BULK_DOWNLOADS_QUEUE is not set');
  }
  const account = process.env.AzureWebJobsStorage__accountName;
  if (!account) {
    throw new Error('bulk download is disabled: AzureWebJobsStorage__accountName is not set');
  }
  if (!client) {
    client = new QueueClient(
      `https://${account}.queue.core.windows.net/${config.bulkDownloadsQueue}`,
      // The client id is required when several user-assigned identities are attached — same
      // reason as src/db/cosmos-nosql.js.
      new DefaultAzureCredential({ managedIdentityClientId: process.env.AZURE_CLIENT_ID })
    );
  }
  return client;
}

async function enqueue(jobId) {
  await queueClient().sendMessage(String(jobId));
}

module.exports = { enqueue };
