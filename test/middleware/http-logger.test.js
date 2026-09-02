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

  await t.test('every other path is logged as it was requested', () => {
    const info = t.mock.method(logger, 'info', () => {});

    logRequest({ method: 'GET', originalUrl: '/api/documents?project=207', headers: {} }, res(), 3);

    assert.strictEqual(info.mock.calls[0].arguments[1].path, '/api/documents');
  });
});
