'use strict';

/**
 * The bulk-download work queue — the only producer side.
 *
 * The message body is the bare job id, unencoded: `host.json` sets `messageEncoding: "none"`, and
 * base64 on this side would reach the trigger as a corrupt id.
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
