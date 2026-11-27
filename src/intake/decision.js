'use strict';

/**
 * Only the exact clean string releases a file, because the release read's ABAC condition matches
 * it exactly; any other result, known or not, rejects it.
 */

const path = require('path');

const CLEAN = 'No threats found';
// Defender appends detail to some results ("Not scanned - blob size exceeded"), so these match by prefix.
const REJECT_PREFIXES = [
  ['Malicious', 'malicious'],
  ['Not scanned', 'not-scanned'],
  ['Scan failed', 'scan-error'],
  ['Error', 'scan-error']
];

/** How long an upload link lives; the controller signs with it and the sweep waits it out. */
const UPLOAD_LINK_SECONDS = 15 * 60;

/** Defender skips larger blobs, so they would only ever reach the timeout. */
const MAX_SCAN_BYTES = 2147483648;

// Same types, signatures and size as eagle-api's Update image upload check.
const UPDATE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_HEAD_BYTES = 12;
const IMAGE_SIGNATURES = {
  'image/jpeg': head => head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  'image/png': head => head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': head => head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP',
  'image/gif': head => ['GIF87a', 'GIF89a'].includes(head.toString('latin1', 0, 6))
};
const IMAGE_TYPE_BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

function decide(result) {
  if (result === CLEAN) return { status: 'clean', reason: null };
  const match = REJECT_PREFIXES.find(([prefix]) => String(result).startsWith(prefix));
  return { status: 'rejected', reason: match ? match[1] : 'unknown-result' };
}

/** `photo.JPG` -> `jpg`; empty for no name or no extension. */
const extensionOf = name => path.extname(String(name || '')).slice(1).toLowerCase();

/**
 * True when an Update image's first bytes, size, stored content type (when set) and every
 * extension agree on one allowed image type.
 */
function isUpdateImage({ head, size, contentType, extensions }) {
  const type = Object.keys(IMAGE_SIGNATURES).find(t => IMAGE_SIGNATURES[t](head));
  const declared = String(contentType || '').split(';')[0].trim().toLowerCase();
  return Boolean(type) && size <= UPDATE_IMAGE_MAX_BYTES && (!declared || declared === type) &&
    extensions.length > 0 && extensions.every(ext => IMAGE_TYPE_BY_EXT[ext] === type);
}

module.exports = {
  decide, extensionOf, isUpdateImage, UPLOAD_LINK_SECONDS, MAX_SCAN_BYTES, UPDATE_IMAGE_MAX_BYTES, IMAGE_HEAD_BYTES
};
