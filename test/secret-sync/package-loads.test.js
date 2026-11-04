'use strict';

// The zip layout differs from the repo's (src/secret-sync host.json at the root, only copied files
// present), so a require reaching out of the app loads in the repo and fails on the Function host.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { stagePackage, linkDependencies, loadStagedEntry, assertRequiresOnlyCopied } = require('../helpers/function-package');

// @azure/keyvault-secrets is no API dependency, so there is nothing to link; vault.js only destructures it.
const STUBS = {
  '@azure/keyvault-secrets': 'module.exports = { SecretClient: class SecretClient {} };\n'
};

test('the packaged layout loads both triggers and requires only what the script copies', (t) => {
  const stage = stagePackage('secret-sync');
  t.after(() => fs.rmSync(stage, { recursive: true, force: true }));
  linkDependencies(stage, STUBS);

  const { exports: entryExports, files } = loadStagedEntry(stage);

  assert.deepStrictEqual(entryExports.sort(), ['onVaultEvent', 'runSync']);
  assertRequiresOnlyCopied(stage, 'secret-sync', files);
});
