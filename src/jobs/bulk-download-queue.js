'use strict';

/**
 * The message body is the bare job id: `host.json` sets `messageEncoding: "none"`, so base64 here
 * would reach the trigger as a corrupt id.
 */

const config = require('../config');
const { queueClientFor } = require('./queue-client');

async function enqueue(jobId) {
  await queueClientFor({
    name: config.bulkDownloadsQueue,
    setting: 'BULK_DOWNLOADS_QUEUE',
    feature: 'bulk download'
  }).sendMessage(String(jobId));
}

module.exports = { enqueue };
