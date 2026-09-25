'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { mirrorError, duplicateIdError } = require('../../src/helpers/duplicate-id');
const { logger } = require('../../src/utils/logger');
const { mockRes } = require('./eagle-mirror-fixtures');

test('mirrorError', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a duplicated id is a 409 that names no row', () => {
    t.mock.method(logger, 'error', () => {});
    const res = mirrorError(mockRes(), duplicateIdError('documents', 'd1', ['207', '208']), 'ctx');

    assert.deepStrictEqual({ status: res.statusCode, body: res.body }, {
      status: 409, body: { error: 'This id is stored more than once. Nothing was written.' }
    });
  });

  await t.test('any other error is the unchanged detail-free 500', () => {
    t.mock.method(logger, 'error', () => {});
    const res = mirrorError(mockRes(), Object.assign(new Error('cosmos said x'), { code: 409 }), 'ctx');

    assert.deepStrictEqual({ status: res.statusCode, body: res.body },
      { status: 500, body: { success: false, error: 'Internal server error.' } });
  });
});
