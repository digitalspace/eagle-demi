'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { stagePackage, linkDependencies, loadStagedEntry, assertRequiresOnlyCopied } = require('../helpers/function-package');

// @azure/functions records registrations instead of talking to a host; keyvault-secrets is no API dependency.
const STUBS = {
  '@azure/functions': 'module.exports = { app: { timer: (name, o) => (globalThis.__timers ||= []).push({ name, schedule: o.schedule }) } };\n',
  '@azure/keyvault-secrets': 'module.exports = { SecretClient: class SecretClient {} };\n'
};

test('the rotator layout loads, registers its hourly timer and requires only what the script copies', (t) => {
  const stage = stagePackage('secret-rotator');
  t.after(() => fs.rmSync(stage, { recursive: true, force: true }));
  linkDependencies(stage, STUBS);

  const { timers, files } = loadStagedEntry(stage);

  assert.deepStrictEqual(timers, [{ name: 'secretRotatorHourly', schedule: '0 0 * * * *' }]);
  assertRequiresOnlyCopied(stage, 'secret-rotator', files);
});
