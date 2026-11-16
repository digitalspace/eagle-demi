'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const azureBlob = require('../../src/storage/azureBlob');
const { uploadSealed } = require('../../src/scripts/works-import-upload');
const { accountOf } = require('../helpers/works-import-fakes');

const DIR = path.join(path.sep, 'home', 'demi', 'works-import');
const NAME = '00000000-0000-4000-8000-000000000000.sealed.json';

test('uploadSealed puts the file from the folder into works-import under its own name', async (t) => {
  const puts = [];
  const factory = t.mock.method(azureBlob, 'createBlobClientFor', () => ({ putFile: async (...args) => { puts.push(args); } }));
  await uploadSealed(accountOf('test'), DIR, NAME);
  assert.deepEqual(factory.mock.calls.map(c => c.arguments), [[accountOf('test'), { container: 'works-import' }]]);
  assert.deepEqual(puts, [[NAME, path.join(DIR, NAME), 'application/json']]);
});

test('a failed upload names the sealed file and keeps the storage error', async (t) => {
  t.mock.method(azureBlob, 'createBlobClientFor', () => ({ putFile: async () => { throw new Error('AuthorizationPermissionMismatch'); } }));
  await assert.rejects(uploadSealed(accountOf('test'), DIR, NAME),
    { message: `upload of ${NAME} to works-import failed: AuthorizationPermissionMismatch` });
});
