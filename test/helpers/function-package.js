'use strict';

// Stages a secret-sync or secret-rotator zip layout with the packaging script's own copy step, so the
// package-loads specs test the script's file list rather than a retyped one.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'package-secret-sync.sh');
const REPO_MODULES = path.join(REPO_ROOT, 'node_modules');
const BANNED = [path.join('src', 'config.js'), path.join('src', 'utils', 'logger.js')];

/** Copy `app` into a fresh directory with `package-secret-sync.sh --stage`; the caller removes it. */
function stagePackage(app) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), `${app}-pkg-`));
  execFileSync('bash', [SCRIPT, '--stage', REPO_ROOT, stage, app]);
  return stage;
}

/** What `npm install --omit=dev` leaves behind: a stub where given, else a link into node_modules. */
function linkDependencies(stage, stubs) {
  const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
  for (const name of Object.keys(manifest.dependencies || {})) {
    const target = path.join(stage, 'node_modules', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (stubs[name]) {
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'index.js'), stubs[name]);
      fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name, version: '0.0.0-stub', main: 'index.js' }));
      continue;
    }
    assert.ok(fs.existsSync(path.join(REPO_MODULES, name)), `${name} is neither in ${REPO_MODULES} nor stubbed`);
    fs.symlinkSync(path.join(REPO_MODULES, name), target);
  }
}

/** Require the staged entry in a child process: its export names, stub-recorded timers, staged files loaded. */
function loadStagedEntry(stage) {
  const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
  const probe = `
    const loaded = require(${JSON.stringify(path.join(stage, manifest.main))});
    const files = Object.keys(require.cache).filter((f) => f.startsWith(${JSON.stringify(stage + path.sep)}));
    process.stdout.write('@@' + JSON.stringify({ exports: Object.keys(loaded), timers: globalThis.__timers || [], files }));
  `;
  const out = execFileSync(process.execPath, ['-e', probe], {
    cwd: stage,
    encoding: 'utf8',
    // The host runs the app with no connection string in a local run; keep the distro out of it.
    env: { ...process.env, APPLICATIONINSIGHTS_CONNECTION_STRING: '' }
  });
  const result = JSON.parse(out.slice(out.indexOf('@@') + 2));
  result.files = result.files.map((f) => path.relative(stage, f)).filter((f) => !f.startsWith('node_modules' + path.sep));
  return result;
}

/** Files the script copied outside src/<app>, repo-relative and sorted. */
function copiedShared(stage, app) {
  const appDir = path.join('src', app) + path.sep;
  return fs
    .readdirSync(path.join(stage, 'src'), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(stage, path.join(e.parentPath, e.name)))
    .filter((f) => !f.startsWith(appDir))
    .sort();
}

/** The app must require, outside src/<app>, exactly the files the script copied there, and none BANNED. */
function assertRequiresOnlyCopied(stage, app, loadedFiles) {
  const appDir = path.join('src', app) + path.sep;
  const copied = copiedShared(stage, app);
  const required = loadedFiles.filter((f) => !f.startsWith(appDir)).sort();
  assert.deepStrictEqual(required, copied, `requires outside src/${app} must be exactly the script's shared files`);
  assert.deepStrictEqual(copied.filter((f) => BANNED.includes(f)), [], `${BANNED.join(' and ')} must never be packaged`);
}

module.exports = { stagePackage, linkDependencies, loadStagedEntry, copiedShared, assertRequiresOnlyCopied };
