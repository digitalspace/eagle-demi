'use strict';

/**
 * What the API deploy package must and must not contain.
 *
 * These are not tidiness assertions. `scripts/package-api.py` excludes the ROOT `scripts` directory
 * — deploy tooling — while `src/scripts` is runtime, required by two controllers. The exclusion is
 * scoped by a `rel_root == "."` guard, and if that guard is ever dropped the package still builds,
 * still deploys, still starts, and then 500s the moment someone calls an admin sync endpoint.
 *
 * Nothing else catches that: no unit test loads the packaged zip, and the failure only appears in
 * Azure. So this test builds the real package and looks inside it.
 */

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Build the package once and return its entry list. */
function packagedEntries() {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'demi-pkg-')), 'api.zip');
  execFileSync('python3', [path.join(REPO_ROOT, 'scripts', 'package-api.py'), REPO_ROOT, out], {
    stdio: 'pipe'
  });
  // `unzip -Z1` lists entry names without extracting — the package is ~26 MB and extracting it
  // for a name check would dominate the suite's runtime.
  const listing = execFileSync('unzip', ['-Z1', out], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
  return new Set(listing.split('\n').filter(Boolean));
}

let entries;
try {
  entries = packagedEntries();
} catch (err) {
  // python3 or unzip missing is an environment problem, not a package defect. Fail loudly rather
  // than silently passing — a skipped guard is the same as no guard.
  throw new Error(`could not build the API package for inspection: ${err.message}`, { cause: err });
}

test('API deploy package', async (t) => {
  await t.test('ships src/scripts — these are RUNTIME, required by controllers', () => {
    // src/controllers/db.js -> require('../scripts/sync-nrpti')
    // src/controllers/wildfire.js -> require('../scripts/sync-wildfires')
    assert.ok(entries.has('src/scripts/sync-nrpti.js'), 'src/scripts/sync-nrpti.js must be packaged');
    assert.ok(
      entries.has('src/scripts/sync-wildfires.js'),
      'src/scripts/sync-wildfires.js must be packaged'
    );
  });

  await t.test('does NOT ship the root scripts/ directory — deploy tooling', () => {
    const rootScripts = [...entries].filter(e => e.startsWith('scripts/'));
    assert.deepStrictEqual(
      rootScripts,
      [],
      `root scripts/ must not be packaged, found: ${rootScripts.join(', ')}`
    );
  });

  await t.test('ships every runtime entry point', () => {
    for (const f of ['index.js', 'api/index.js', 'host.json', 'package.json']) {
      assert.ok(entries.has(f), `${f} must be packaged`);
    }
    assert.ok(
      [...entries].some(e => e.startsWith('node_modules/')),
      'node_modules must be packaged — the app cannot npm install, its VNet has no route to the registry'
    );
  });

  await t.test('ships the geojson the boundary seeder reads', () => {
    assert.ok(
      [...entries].some(e => e.startsWith('frontend/public/assets/geojson/')),
      'frontend is excluded wholesale, so the geojson re-include must still land'
    );
  });

  await t.test('does not ship non-runtime directories', () => {
    for (const dir of ['test/', 'azure/', '.github/', '.vscode/', '.claude/', '.git/']) {
      const hits = [...entries].filter(e => e.startsWith(dir));
      assert.deepStrictEqual(hits, [], `${dir} must not be packaged, found ${hits.length} entries`);
    }
  });

  await t.test('never ships a .env at any depth', () => {
    // This one carried live database and object-storage credentials into a world-readable path
    // once already. Depth-independent, by name — ".env" has no extension to filter on.
    const envs = [...entries].filter(e => {
      const base = e.split('/').pop();
      return base === '.env' || base.startsWith('.env.');
    });
    assert.deepStrictEqual(envs, [], `no .env may be packaged, found: ${envs.join(', ')}`);
  });
});
