'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { testEnvironment } = require('../../src/scripts/works-import-inputs');
const { NUMBER, PROJECT, inputs, load } = require('../helpers/works-import-loader');

const swap = (argv, flag, value) => argv.map((arg, i) => (argv[i - 1] === flag ? value : arg));
const valueOf = (argv, flag) => argv[argv.indexOf(flag) + 1];

test('refuses a devbox key whose fingerprint is not --expect-devbox-fingerprint', async () => {
  const { argv } = inputs();
  await assert.rejects(load(swap(argv, '--expect-devbox-fingerprint', '0'.repeat(64))), /fingerprint of the devbox key/);
});

test('refuses a devbox key file that group or others may read', async () => {
  const { argv } = inputs();
  fs.chmodSync(valueOf(argv, '--devbox-key'), 0o640);
  await assert.rejects(load(argv), /0600 file/);
});

test('refuses a devbox key whose folder is not 0700', async () => {
  const { argv } = inputs();
  fs.chmodSync(path.dirname(valueOf(argv, '--devbox-key')), 0o750);
  await assert.rejects(load(argv), /folder must be 0700/);
});

test('refuses an --out-dir that is a symbolic link', async () => {
  const { argv, outDir, dir } = inputs();
  const link = path.join(dir, 'out-link');
  fs.symlinkSync(outDir, link);
  await assert.rejects(load(swap(argv, '--out-dir', link)), /--out-dir must be a folder/);
});

test('refuses an --out-dir others may write to', async () => {
  const { argv, outDir } = inputs();
  fs.chmodSync(outDir, 0o770);
  await assert.rejects(load(argv), /--out-dir must be a folder/);
});

test('refuses a Cosmos endpoint that is not https', () => {
  assert.throws(() => testEnvironment('http://demi-cosmos-test.documents.azure.com:443/', 'demi'), /test only/);
});

test('refuses a Cosmos database other than the test one', () => {
  assert.throws(() => testEnvironment('https://demi-cosmos-test.documents.azure.com:443/', 'other'), /database is not demi/);
});

test('refuses an option given twice', async () => {
  const { argv } = inputs();
  await assert.rejects(load([...argv, '--out-dir', valueOf(argv, '--out-dir')]), /given once/);
});

test('refuses a crosswalk that names one sheet number twice', async () => {
  const row = { row: 5, sheetId: NUMBER, state: 'exact', targetId: PROJECT };
  await assert.rejects(load(inputs({ crosswalkRows: [row, { ...row, row: 6 }] }).argv), /one sheet number twice/);
});
