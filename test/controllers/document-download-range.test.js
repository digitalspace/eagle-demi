'use strict';

// The stream cap applies to the bytes of one answer, so the edge can fetch a large file in pieces.
// An anonymous edge-stamped caller is never sent to the store's URL: it gets the bytes, a 404 or a 503.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { once } = require('events');
const { Readable } = require('stream');
const storage = require('../../src/storage');
const { logger } = require('../../src/utils/logger');
const config = require('../../src/config');
const controller = require('../../src/controllers/nosql/document');
const {
  URL_WITH_DISPOSITION, DOC, BYTES, STAT, LAST_MODIFIED, req, res, stored, get, holdOpen
} = require('../helpers/download-stream');

// A fake value: fromEdge compares the request header against config.edgeSecret.
const EDGE = { 'x-edge-secret': 'edge-secret-for-download-range-suite' };
// Verified auth with no privileged role, as a public-tier API key resolves.
const KEY_USER = { realm_access: { roles: [] } };

/** Takes a slot with a read that never ends, freed when the test ends. */
async function holdSlot(t, open, request) {
  open.mock.mockImplementationOnce(async () => {
    const source = new Readable({ read() {} });
    source.push(BYTES);
    return source;
  });
  const held = await holdOpen(request);
  const source = await open.mock.calls.at(-1).result;
  t.after(async () => {
    held.destroy();
    await once(source, 'close');
  });
}

/** The handler called directly for a credentialed caller; a streamed body is drained to free its slot. */
async function getAs(user, headers) {
  const out = res();
  await controller.downloadDocument(req({ user, headers, query: { inline: '1' } }), out);
  if (out.streamed) await out.body.toArray();
  return out;
}

test('stream mode caps each answer, not the file', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  const {
    downloadStreamMaxBytes, downloadStreamMaxConcurrent, downloadStreamEdgeMaxConcurrent, edgeSecret
  } = config;
  t.afterEach(() => Object.assign(config, {
    downloadStreamMaxBytes, downloadStreamMaxConcurrent, downloadStreamEdgeMaxConcurrent, edgeSecret
  }));

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

  await t.test('an edge piece streams while the edge stream slots are full', async (t) => {
    config.downloadStreamEdgeMaxConcurrent = 1;
    config.edgeSecret = EDGE['x-edge-secret'];
    await holdSlot(t, stored(t).open, { headers: EDGE });
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

  await t.test('a credentialed edge-stamped mid-file piece the store will not open answers 503', async (t) => {
    config.edgeSecret = EDGE['x-edge-secret'];
    const { presign } = stored(t);
    t.mock.method(storage, 'getObjectStream', async () => { throw new Error('refused'); });
    t.mock.method(logger, 'warn', () => {});
    const out = await getAs(KEY_USER, { ...EDGE, range: 'bytes=1024-2047' });
    assert.equal(out.statusCode, 503);
    assert.equal(out.headers['retry-after'], '5');
    assert.equal(out.headers['cache-control'], 'no-store');
    assert.equal(presign.mock.callCount(), 0);
  });

  await t.test('a failed stat on an edge-stamped request answers 503, not the 302', async (t) => {
    config.edgeSecret = EDGE['x-edge-secret'];
    const { presign } = stored(t);
    t.mock.method(storage, 'statObject', async () => { throw new Error('store down'); });
    t.mock.method(logger, 'warn', () => {});
    const { res: r } = await get(EDGE);
    assert.equal(r.status, 503);
    assert.equal(r.headers.get('retry-after'), '5');
    assert.equal(presign.mock.callCount(), 0);
  });

  await t.test('a store open failure on the first piece answers 503, never a Location', async (t) => {
    config.edgeSecret = EDGE['x-edge-secret'];
    const { presign } = stored(t);
    t.mock.method(storage, 'getObjectStream', async () => { throw new Error('refused'); });
    t.mock.method(logger, 'warn', () => {});
    const { res: r } = await get({ ...EDGE, range: 'bytes=0-1023' });
    assert.equal(r.status, 503);
    assert.equal(r.headers.get('retry-after'), '5');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('location'), null);
    assert.equal(presign.mock.callCount(), 0);
  });

  await t.test('an edge-stamped unranged request for a file over the cap streams the whole file', async (t) => {
    config.downloadStreamMaxBytes = BYTES.length - 1;
    config.edgeSecret = EDGE['x-edge-secret'];
    const { presign } = stored(t);
    t.mock.method(logger, 'info', () => {});
    const { res: r, body } = await get(EDGE);
    assert.equal(r.status, 200);
    assert.deepEqual(body, BYTES);
    assert.equal(r.headers.get('content-length'), '4096');
    assert.equal(r.headers.get('location'), null);
    assert.equal(presign.mock.callCount(), 0);
  });

  await t.test('an edge-stamped request at the slot cap answers 503 with Retry-After, never a Location',
    async (t) => {
      config.downloadStreamEdgeMaxConcurrent = 1;
      config.edgeSecret = EDGE['x-edge-secret'];
      t.mock.method(logger, 'info', () => {});
      t.mock.method(logger, 'warn', () => {});
      const { presign, open } = stored(t);
      await holdSlot(t, open, { headers: EDGE });
      const { res: r, body } = await get(EDGE);
      assert.equal(r.status, 503);
      assert.equal(r.headers.get('retry-after'), '5');
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal(r.headers.get('location'), null);
      assert.equal(body.toString(), 'Busy, reload in a few seconds.\n');
      assert.equal(presign.mock.callCount(), 0);
    });

  await t.test('an edge-stamped open-ended range takes a stream slot', async (t) => {
    config.downloadStreamEdgeMaxConcurrent = 1;
    config.edgeSecret = EDGE['x-edge-secret'];
    t.mock.method(logger, 'info', () => {});
    t.mock.method(logger, 'warn', () => {});
    await holdSlot(t, stored(t).open, { headers: EDGE });
    const { res: r } = await get({ ...EDGE, range: 'bytes=1024-' });
    assert.equal(r.status, 503);
  });

  await t.test('an edge-stamped closed range over 8 MiB takes a stream slot', async (t) => {
    config.downloadStreamEdgeMaxConcurrent = 1;
    config.edgeSecret = EDGE['x-edge-secret'];
    t.mock.method(logger, 'info', () => {});
    t.mock.method(logger, 'warn', () => {});
    await holdSlot(t, stored(t, { stat: { ...STAT, size: 16 * 1024 * 1024 } }).open, { headers: EDGE });
    const { res: r } = await get({ ...EDGE, range: `bytes=0-${8 * 1024 * 1024}` });
    assert.equal(r.status, 503);
  });

  await t.test('an edge-stamped inline request for a type not shown inline streams as an attachment',
    async (t) => {
      config.edgeSecret = EDGE['x-edge-secret'];
      t.mock.method(logger, 'info', () => {});
      const { presign } = stored(t, { doc: { ...DOC, mimeType: 'application/zip' } });
      const { res: r, body } = await get(EDGE);
      assert.equal(r.status, 200);
      assert.deepEqual(body, BYTES);
      assert.equal(r.headers.get('content-type'), 'application/octet-stream');
      assert.match(r.headers.get('content-disposition'), /^attachment;/);
      assert.equal(presign.mock.callCount(), 0);
    });

  await t.test('an edge-stamped request for a missing object answers 404', async (t) => {
    config.edgeSecret = EDGE['x-edge-secret'];
    const { presign } = stored(t, { stat: null });
    const { res: r } = await get(EDGE);
    assert.equal(r.status, 404);
    assert.equal(r.headers.get('location'), null);
    assert.equal(presign.mock.callCount(), 0);
  });

  await t.test('an edge-stamped request for an empty file answers 200 with no body', async (t) => {
    config.edgeSecret = EDGE['x-edge-secret'];
    t.mock.method(logger, 'warn', () => {});
    const { presign, open } = stored(t, { stat: { ...STAT, size: 0 } });
    const { res: r, body } = await get(EDGE);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-length'), '0');
    assert.equal(body.length, 0);
    assert.equal(r.headers.get('location'), null);
    assert.equal(presign.mock.callCount(), 0);
    assert.equal(open.mock.callCount(), 0);
  });

  await t.test('a direct caller at its slot cap leaves edge stream slots free', async (t) => {
    config.downloadStreamMaxConcurrent = 1;
    config.downloadStreamEdgeMaxConcurrent = 1;
    config.edgeSecret = EDGE['x-edge-secret'];
    t.mock.method(logger, 'info', () => {});
    await holdSlot(t, stored(t).open);
    const { res: r, body } = await get(EDGE);
    assert.equal(r.status, 200);
    assert.deepEqual(body, BYTES);
  });

  await t.test('a credentialed edge-stamped request over the cap keeps the 302', async (t) => {
    config.downloadStreamMaxBytes = BYTES.length - 1;
    config.edgeSecret = EDGE['x-edge-secret'];
    const { open } = stored(t);
    t.mock.method(logger, 'info', () => {});
    const out = await getAs(KEY_USER, EDGE);
    assert.equal(out.statusCode, 302);
    assert.equal(out.headers.location, URL_WITH_DISPOSITION);
    assert.equal(open.mock.callCount(), 0);
  });

  await t.test('a credentialed edge-stamped request at the direct slot cap gets the 302', async (t) => {
    config.downloadStreamMaxConcurrent = 1;
    config.downloadStreamEdgeMaxConcurrent = 0;
    config.edgeSecret = EDGE['x-edge-secret'];
    t.mock.method(logger, 'info', () => {});
    await holdSlot(t, stored(t).open);
    const out = await getAs(KEY_USER, EDGE);
    assert.equal(out.statusCode, 302);
    assert.equal(out.headers.location, URL_WITH_DISPOSITION);
  });

  await t.test('a cap of 0 sends an anonymous edge-stamped request to the 302', async (t) => {
    config.downloadStreamMaxBytes = 0;
    config.edgeSecret = EDGE['x-edge-secret'];
    const { open } = stored(t);
    const { res: r } = await get(EDGE);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), URL_WITH_DISPOSITION);
    assert.equal(open.mock.callCount(), 0);
  });
});
