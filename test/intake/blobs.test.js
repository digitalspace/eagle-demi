'use strict';

/**
 * moveToQuarantine through a real `createBlobClientFor` client, with the SDK's network calls
 * replaced: the copy must land in the quarantine container of the intake account, read through a
 * read-only SAS on `incoming`, and the staging blob must go.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { BlobServiceClient, BlockBlobClient } = require('@azure/storage-blob');

const { createBlobClientFor } = require('../../src/storage/azureBlob');
const { moveToQuarantine } = require('../../src/intake/blobs');
const { ACCOUNT, setIntakeEnv } = require('./fakes');

// Shape and Date fields as test/storage/storage.test.js explains; the SAS is a real HMAC over `value`.
const FAKE_KEY = {
  signedObjectId: '00000000-0000-0000-0000-000000000001',
  signedTenantId: '00000000-0000-0000-0000-000000000002',
  signedStartsOn: new Date('2026-10-14T00:00:00Z'),
  signedExpiresOn: new Date('2026-10-14T01:00:00Z'),
  signedService: 'b',
  signedVersion: '2024-11-04',
  value: Buffer.from('not-a-real-key').toString('base64')
};
const NO_TOKEN = { getToken: async () => { throw new Error('no network in tests'); } };

function intakeClient() {
  return createBlobClientFor(ACCOUNT, { container: 'incoming', credential: NO_TOKEN });
}

function recordBlobCalls(t, { exists = true } = {}) {
  const calls = { copies: [], deletes: [] };
  t.mock.method(BlobServiceClient.prototype, 'getUserDelegationKey', async () => FAKE_KEY);
  t.mock.method(BlockBlobClient.prototype, 'getProperties', async function () {
    if (!exists) throw Object.assign(new Error('not found'), { details: { errorCode: 'BlobNotFound' } });
    return { contentLength: 42, etag: '"0x8DCB01"' };
  });
  t.mock.method(BlockBlobClient.prototype, 'beginCopyFromURL', async function (url, options) {
    calls.copies.push({ dest: new URL(this.url), source: new URL(url), options });
    return { pollUntilDone: async () => ({ copyStatus: 'success' }) };
  });
  t.mock.method(BlockBlobClient.prototype, 'deleteIfExists', async function () {
    calls.deletes.push(new URL(this.url));
  });
  return calls;
}

test('the copy lands in the quarantine container of the intake account', async (t) => {
  setIntakeEnv(t);
  const calls = recordBlobCalls(t);

  await moveToQuarantine(intakeClient(), 'doc-1');

  assert.strictEqual(calls.copies.length, 1);
  assert.strictEqual(calls.copies[0].dest.host, `${ACCOUNT}.blob.core.windows.net`);
  assert.strictEqual(calls.copies[0].dest.pathname, '/quarantine/doc-1');
});

test('the copy reads incoming through a read-only SAS, pinned to the etag it saw', async (t) => {
  setIntakeEnv(t);
  const calls = recordBlobCalls(t);

  await moveToQuarantine(intakeClient(), 'doc-1');

  const { source, options } = calls.copies[0];
  assert.strictEqual(source.pathname, '/incoming/doc-1');
  assert.strictEqual(source.searchParams.get('sp'), 'r');
  assert.strictEqual(options.sourceConditions.ifMatch, '"0x8DCB01"');
});

test('INTAKE_QUARANTINE_CONTAINER names the destination', async (t) => {
  setIntakeEnv(t, { INTAKE_STORAGE_ACCOUNT: ACCOUNT, INTAKE_QUARANTINE_CONTAINER: 'held' });
  const calls = recordBlobCalls(t);

  await moveToQuarantine(intakeClient(), 'doc-1');

  assert.strictEqual(calls.copies[0].dest.pathname, '/held/doc-1');
});

test('the staging blob is deleted after the copy, and its size returned', async (t) => {
  setIntakeEnv(t);
  const calls = recordBlobCalls(t);

  const stat = await moveToQuarantine(intakeClient(), 'doc-1');

  assert.deepStrictEqual(calls.deletes.map(u => u.pathname), ['/incoming/doc-1']);
  assert.strictEqual(stat.size, 42);
});

test('no blob: nothing is copied or deleted, and null comes back', async (t) => {
  setIntakeEnv(t);
  const calls = recordBlobCalls(t, { exists: false });

  const stat = await moveToQuarantine(intakeClient(), 'doc-1');

  assert.strictEqual(stat, null);
  assert.strictEqual(calls.copies.length + calls.deletes.length, 0);
});

test('createBlobClientFor refuses a missing container by name', async () => {
  const client = createBlobClientFor(ACCOUNT, { credential: NO_TOKEN });

  await assert.rejects(client.statObject('doc-1'), /a container is required for demiintest/);
});
