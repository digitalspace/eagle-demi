'use strict';

/**
 * The zip scripts/package-secret-sync.sh builds must LOAD.
 *
 * The other secret-sync specs require the modules from the repo layout, where `../host.json` is the
 * API's root file and `../config` is reachable. The zip is a different layout: src/secret-sync
 * host.json sits at the root and only the files the script copies are there. A require that reaches
 * out of src/secret-sync therefore either resolves to a file that is not the one it means or is not
 * in the zip at all, and the Function app fails to start with no test having noticed.
 *
 * So this spec stages the script's own copy list — read out of the script, not retyped here, so a
 * copy added or dropped there is a copy added or dropped here — and requires the staged entry
 * point in a child process, then asserts nothing outside src/secret-sync was pulled in.
 *
 * Dependencies: four of the five in src/secret-sync/package.json are also API dependencies and are
 * linked in from the repo's node_modules. @azure/keyvault-secrets is not an API dependency, so
 * there is no copy to link — the deploy gets it from `npm install` inside the script, and this
 * spec stands in a stub for it rather than reaching the network on every test run. The stub only
 * has to satisfy the destructure in vault.js; what is under test is the repo's own require graph.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'package-secret-sync.sh');
const REPO_MODULES = path.join(REPO_ROOT, 'node_modules');

// Stand-ins for dependencies the API itself does not install. Each exports the names the sync code
// destructures at module scope; a dependency missing from both this map and node_modules fails the
// test rather than being skipped.
const STUBS = {
  '@azure/keyvault-secrets': 'module.exports = { SecretClient: class SecretClient {} };\n'
};

/** The `mkdir`/`cp` lines of the packaging script, run against a staging directory. */
function stageFromScript(stage) {
  const copyLines = fs
    .readFileSync(SCRIPT, 'utf8')
    .split('\n')
    .filter((line) => /^\s*(mkdir|cp)\s/.test(line));
  assert.ok(copyLines.length > 0, 'no mkdir/cp lines found in package-secret-sync.sh');
  execFileSync('bash', ['-euo', 'pipefail', '-c', copyLines.join('\n')], {
    env: { ...process.env, REPO_ROOT, STAGE: stage }
  });
}

/** What `npm install --omit=dev` in the script leaves behind, without the network round trip. */
function installDependencies(stage) {
  const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
  for (const name of Object.keys(manifest.dependencies || {})) {
    const target = path.join(stage, 'node_modules', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const installed = path.join(REPO_MODULES, name);
    if (fs.existsSync(installed)) {
      fs.symlinkSync(installed, target);
      continue;
    }
    assert.ok(STUBS[name], `${name} is neither in ${REPO_MODULES} nor stubbed by this spec`);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'index.js'), STUBS[name]);
    fs.writeFileSync(
      path.join(target, 'package.json'),
      JSON.stringify({ name, version: '0.0.0-stub', main: 'index.js' })
    );
  }
}

/**
 * Load the staged entry in a child process and report what it required.
 * @param {string} stage staging directory
 * @returns {{exports: string[], files: string[]}} entry exports, and staged files in the graph
 */
function loadStagedEntry(stage) {
  const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
  const entry = path.join(stage, manifest.main);
  const probe = `
    const loaded = require(${JSON.stringify(entry)});
    const files = Object.keys(require.cache).filter((f) => f.startsWith(${JSON.stringify(stage + path.sep)}));
    process.stdout.write('@@' + JSON.stringify({ exports: Object.keys(loaded), files }));
  `;
  const out = execFileSync(process.execPath, ['-e', probe], {
    cwd: stage,
    encoding: 'utf8',
    // The host runs the app with no connection string in a local run; keep the distro out of it.
    env: { ...process.env, APPLICATIONINSIGHTS_CONNECTION_STRING: '' }
  });
  return JSON.parse(out.slice(out.indexOf('@@') + 2));
}

test('the packaged layout loads its entry point', (t) => {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-sync-pkg-'));
  t.after(() => fs.rmSync(stage, { recursive: true, force: true }));

  stageFromScript(stage);
  installDependencies(stage);
  const { exports: entryExports, files } = loadStagedEntry(stage);

  assert.deepStrictEqual(
    entryExports.sort(),
    ['onVaultEvent', 'runSync'],
    'the packaged entry point must expose both triggers'
  );

  // Everything the app requires out of this repo has to be inside src/secret-sync. src/config.js is
  // the one that got in before: it parses the API's host.json and refuses to load without the API's
  // app settings, so requiring it — directly or through src/utils/logger.js — kills the app.
  const strays = files
    .map((file) => path.relative(stage, file))
    .filter((file) => !file.startsWith('node_modules' + path.sep))
    .filter((file) => !file.startsWith(path.join('src', 'secret-sync') + path.sep));
  assert.deepStrictEqual(strays, [], 'the sync app must require nothing outside src/secret-sync');
});

test('the packaged layout carries no file the app does not require', () => {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-sync-pkg-'));
  try {
    stageFromScript(stage);
    const staged = fs.readdirSync(path.join(stage, 'src'), { recursive: true });
    // src/secret-sync itself, and nothing else at any depth: src/config.js is the API's
    // configuration and src/utils/logger.js is what used to drag it in.
    const outside = staged.filter((file) => file !== 'secret-sync' && !file.startsWith('secret-sync' + path.sep));
    assert.deepStrictEqual(outside, [], 'only src/secret-sync belongs in the zip');
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
});
