'use strict';

// The rotator zip layout must load and register its timer. Staged here from the files the app needs,
// so a require reaching outside src/secret-rotator plus SHARED fails this spec before a deploy does.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REPO_MODULES = path.join(REPO_ROOT, 'node_modules');
const APP = path.join('src', 'secret-rotator');
// The files outside src/secret-rotator a rotator zip must copy in. Each must stay free of src/config.js.
const SHARED = [path.join('src', 'secret-sync', 'logger.js'), path.join('src', 'utils', 'azure-credential.js')];

// @azure/functions records registrations instead of talking to a host; keyvault-secrets is no API dependency.
const STUBS = {
  '@azure/functions': 'module.exports = { app: { timer: (name, o) => (globalThis.__timers ||= []).push({ name, schedule: o.schedule }) } };\n',
  '@azure/keyvault-secrets': 'module.exports = { SecretClient: class SecretClient {} };\n'
};

function stageApp(stage) {
  fs.copyFileSync(path.join(REPO_ROOT, APP, 'host.json'), path.join(stage, 'host.json'));
  fs.copyFileSync(path.join(REPO_ROOT, APP, 'package.json'), path.join(stage, 'package.json'));
  for (const file of [APP, ...SHARED]) {
    fs.mkdirSync(path.dirname(path.join(stage, file)), { recursive: true });
    fs.cpSync(path.join(REPO_ROOT, file), path.join(stage, file), { recursive: true });
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
  for (const name of Object.keys(manifest.dependencies || {})) {
    const target = path.join(stage, 'node_modules', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (STUBS[name]) {
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'index.js'), STUBS[name]);
      fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name, version: '0.0.0-stub', main: 'index.js' }));
    } else {
      assert.ok(fs.existsSync(path.join(REPO_MODULES, name)), `${name} is neither in ${REPO_MODULES} nor stubbed`);
      fs.symlinkSync(path.join(REPO_MODULES, name), target);
    }
  }
  return manifest;
}

test('the rotator layout loads, registers its hourly timer and requires only SHARED outside its dir', (t) => {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-rotator-pkg-'));
  t.after(() => fs.rmSync(stage, { recursive: true, force: true }));
  const manifest = stageApp(stage);

  const probe = `
    require(${JSON.stringify(path.join(stage, manifest.main))});
    const files = Object.keys(require.cache).filter((f) => f.startsWith(${JSON.stringify(stage + path.sep)}));
    process.stdout.write('@@' + JSON.stringify({ timers: globalThis.__timers || [], files }));
  `;
  const out = execFileSync(process.execPath, ['-e', probe], {
    cwd: stage,
    encoding: 'utf8',
    env: { ...process.env, APPLICATIONINSIGHTS_CONNECTION_STRING: '' }
  });
  const { timers, files } = JSON.parse(out.slice(out.indexOf('@@') + 2));

  assert.deepStrictEqual(timers, [{ name: 'secretRotatorHourly', schedule: '0 0 * * * *' }]);
  const outside = files
    .map((file) => path.relative(stage, file))
    .filter((file) => !file.startsWith('node_modules' + path.sep) && !file.startsWith(APP + path.sep))
    .sort();
  assert.deepStrictEqual(outside, [...SHARED].sort(), 'requires outside src/secret-rotator must be exactly SHARED');
});
