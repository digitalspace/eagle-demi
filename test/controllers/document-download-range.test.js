'use strict';

// The stream cap applies to the bytes of one answer, so the edge can fetch a large file in pieces.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { once } = require('events');
const { Readable } = require('stream');
const storage = require('../../src/storage');
const { logger } = require('../../src/utils/logger');
const config = require('../../src/config');
const {
  URL_WITH_DISPOSITION, BYTES, LAST_MODIFIED, stored, get, holdOpen
} = require('../helpers/download-stream');

// A fake value: fromEdge compares the request header against config.edgeSecret.
const EDGE = { 'x-edge-secret': 'edge-secret-for-download-range-suite' };

/** Takes a slot with a read that never ends, freed when the test ends. */
async function holdSlot(t, open) {
  open.mock.mockImplementationOnce(async () => {
    const source = new Readable({ read() {} });
    source.push(BYTES);
    return source;
  });
  const held = await holdOpen();
  const source = await open.mock.calls.at(-1).result;
  t.after(async () => {
    held.destroy();
    await once(source, 'close');
  });
}

test('stream mode caps each answer, not the file', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const { downloadStreamMaxBytes, downloadStreamMaxConcurrent, edgeSecret } = config;
  t.afterEach(() => Object.assign(config, { downloadStreamMaxBytes, downloadStreamMaxConcurrent, edgeSecret }));

  await t.test('an unranged request for a file over the cap is the inline 302, no-store', async (t) => {
    config.downloadStreamMaxBytes = BYTES.length - 1;
    const { presign, open } = stored(t);
    t.mock.method(logger, 'info', () => {});
    const { res: r } = await get();
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), URL_WITH_DISPOSITION);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(presign.mock.calls[0].arguments[1].inlineType, 'application/pdf');
    assert.equal(open.mock.callCount(), 0);
  });

  await t.test('a range within the cap of a file over the cap answers 206', async (t) => {
    config.downloadStreamMaxBytes = 1024;
    const { presign } = stored(t);
    const { res: r, body } = await get({ range: 'bytes=1024-2047' });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 1024-2047/4096');
    assert.deepEqual(body, BYTES.subarray(1024, 2048));
    assert.equal(presign.mock.callCount(), 0);
  });

  await t.test('an open-ended range over the cap is the 302', async (t) => {
    config.downloadStreamMaxBytes = 1024;
    const { open } = stored(t);
    t.mock.method(logger, 'info', () => {});
    const { res: r } = await get({ range: 'bytes=1024-' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(open.mock.callCount(), 0);
  });

  await t.test('a 304 is answered for a file over the cap', async (t) => {
    config.downloadStreamMaxBytes = BYTES.length - 1;
    const { presign } = stored(t);
    const { res: r } = await get({ 'if-modified-since': LAST_MODIFIED });
    assert.equal(r.status, 304);
    assert.equal(r.headers.get('location'), null);
    assert.equal(presign.mock.callCount(), 0);
  });

  await t.test('a ranged edge request within the byte cap streams when the instance is at its slot cap',
    async (t) => {
      config.downloadStreamMaxConcurrent = 1;
      config.edgeSecret = EDGE['x-edge-secret'];
      await holdSlot(t, stored(t).open);
      const { res: r } = await get({ ...EDGE, range: 'bytes=1024-2047' });
      assert.equal(r.status, 206);
    });

  await t.test('a ranged request without the edge stamp at the slot cap gets the 302', async (t) => {
    config.downloadStreamMaxConcurrent = 1;
    config.edgeSecret = EDGE['x-edge-secret'];
    t.mock.method(logger, 'info', () => {});
    await holdSlot(t, stored(t).open);
    const { res: r } = await get({ range: 'bytes=1024-2047' });
    assert.equal(r.status, 302);
  });

  await t.test('a store open failure on a mid-file piece answers 503 with Retry-After, no-store', async (t) => {
    config.edgeSecret = EDGE['x-edge-secret'];
    const { presign } = stored(t);
    t.mock.method(storage, 'getObjectStream', async () => { throw new Error('refused'); });
    t.mock.method(logger, 'warn', () => {});
    const { res: r } = await get({ ...EDGE, range: 'bytes=1024-2047' });
    assert.equal(r.status, 503);
    assert.equal(r.headers.get('retry-after'), '5');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(presign.mock.callCount(), 0);
  });

  await t.test('a failed stat on a mid-file edge piece answers 503, not the 302', async (t) => {
    config.edgeSecret = EDGE['x-edge-secret'];
    const { presign } = stored(t);
    t.mock.method(storage, 'statObject', async () => { throw new Error('store down'); });
    t.mock.method(logger, 'warn', () => {});
    const { res: r } = await get({ ...EDGE, range: 'bytes=1024-2047' });
    assert.equal(r.status, 503);
    assert.equal(r.headers.get('retry-after'), '5');
    assert.equal(presign.mock.callCount(), 0);
  });

  await t.test('a store open failure on the first piece is the inline 302', async (t) => {
    config.edgeSecret = EDGE['x-edge-secret'];
    stored(t);
    t.mock.method(storage, 'getObjectStream', async () => { throw new Error('refused'); });
    t.mock.method(logger, 'warn', () => {});
    const { res: r } = await get({ ...EDGE, range: 'bytes=0-1023' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), URL_WITH_DISPOSITION);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });
});
