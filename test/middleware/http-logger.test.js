'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { logger } = require('../../src/utils/logger');
const { logRequest } = require('../../src/middleware/http-logger');

function res(statusCode = 200) {
  return { statusCode, get: () => 0 };
}

test('access log', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a bulk download job id is masked out of the line and the metadata', () => {
    // The job id is a bearer capability: whoever reads it out of the log stream can fetch the zip.
    const info = t.mock.method(logger, 'info', () => {});

    logRequest({
      method: 'GET',
      originalUrl: '/api/bulk-downloads/6f1c4b9e-0d2a-4d9d-9c3e-1f5f9a2b7c40',
      headers: {}
    }, res(), 12);

    const [message, meta] = info.mock.calls[0].arguments;
    assert.ok(!message.includes('6f1c4b9e'), `the id survived into the line: ${message}`);
    assert.match(message, /\/api\/bulk-downloads\/<id>/);
    assert.strictEqual(meta.path, '/api/bulk-downloads/<id>');
  });

  await t.test('the request line for suggest carries the path only, not the typed prefix', () => {
    // Suggest runs per keystroke; its query would log every half-typed word beside the caller's IP.
    // The router strips trailing slashes, so `/api/suggest//` reaches the same handler; bare `/suggest` too.
    for (const path of ['/api/suggest', '/api/suggest/', '/api/suggest//', '/suggest', '/suggest/']) {
      const info = t.mock.method(logger, 'info', () => {});

      logRequest({ method: 'GET', originalUrl: `${path}?kind=projects&q=site%20c&limit=8`, headers: {} }, res(), 4);

      const [message, meta] = info.mock.calls[0].arguments;
      assert.ok(message.startsWith(`GET ${path} 200 `), message);
      assert.ok(!/[?]|site|kind=/.test(message), `the query survived into the line: ${message}`);
      assert.strictEqual(meta.path, path);
      assert.ok(!JSON.stringify(meta).includes('site'), 'the query survived into the metadata');
      info.mock.restore();
    }
  });

  await t.test('a path that ends in suggest under another route keeps its query in the line', () => {
    const info = t.mock.method(logger, 'info', () => {});

    logRequest({ method: 'GET', originalUrl: '/api/projects/suggest?q=site', headers: {} }, res(), 4);

    assert.ok(info.mock.calls[0].arguments[0].startsWith('GET /api/projects/suggest?q=site 200 '));
  });

  await t.test('a path that only starts with suggest keeps its query in the line', () => {
    const info = t.mock.method(logger, 'info', () => {});

    logRequest({ method: 'GET', originalUrl: '/api/suggestions?q=site', headers: {} }, res(), 4);

    assert.ok(info.mock.calls[0].arguments[0].startsWith('GET /api/suggestions?q=site 200 '));
  });

  await t.test('every other path is logged as it was requested', () => {
    const info = t.mock.method(logger, 'info', () => {});

    logRequest({ method: 'GET', originalUrl: '/api/documents?project=207', headers: {} }, res(), 3);

    assert.strictEqual(info.mock.calls[0].arguments[1].path, '/api/documents');
  });

  await t.test('a HEAD logs 0 bytes, not the size of the file it describes', () => {
    const info = t.mock.method(logger, 'info', () => {});
    const head = { statusCode: 200, get: (name) => (/^content-length$/i.test(name) ? '48213' : undefined) };

    logRequest({ method: 'HEAD', originalUrl: '/api/documents/doc-1/download', headers: {} }, head, 2);

    const [message, meta] = info.mock.calls[0].arguments;
    assert.match(message, / 200 - 0 B - /);
    assert.strictEqual(meta.bytes, 0);
  });
});
