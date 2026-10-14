'use strict';

/**
 * Clients for the intake account. Two identities on purpose: the app identity can read a file in
 * `incoming` only once Defender tagged it clean (ABAC), and only the quarantine identity can read
 * the tags of, copy and delete a file that is not. Neither can write a tag.
 */

const config = require('../config');
const { createBlobClientFor } = require('../storage/azureBlob');
const { createCredential } = require('../utils/azure-credential');

let stagingClient;
let quarantineClient;

/** The app identity's view of `incoming`. */
function staging() {
  if (!stagingClient) {
    const { storageAccount, incomingContainer } = config.intake;
    stagingClient = createBlobClientFor(storageAccount, { container: incomingContainer });
  }
  return stagingClient;
}

/** The quarantine identity's view of `incoming`. */
function quarantine() {
  if (!quarantineClient) {
    const { storageAccount, incomingContainer, quarantineClientId } = config.intake;
    if (!quarantineClientId) {
      throw new Error('[intake] INTAKE_QUARANTINE_CLIENT_ID is required to quarantine a file');
    }
    const credential = createCredential({ ...process.env, AZURE_CLIENT_ID: quarantineClientId });
    quarantineClient = createBlobClientFor(storageAccount, { container: incomingContainer, credential });
  }
  return quarantineClient;
}

/**
 * Move one upload from `incoming` to the quarantine container. Returns the blob's properties, or
 * null when there was nothing to move.
 */
async function moveToQuarantine(client, id) {
  const stat = await client.statObject(id);
  if (!stat) return null;
  await client.copyObject(id, id, {
    destContainer: config.intake.quarantineContainer,
    ifSourceEtag: stat.etag || undefined
  });
  await client.removeObject(id);
  return stat;
}

module.exports = { staging, quarantine, moveToQuarantine };
