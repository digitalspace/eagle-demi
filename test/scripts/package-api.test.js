'use strict';

// Builds the real deploy package and looks inside: a wrong exclusion still deploys and starts,
// then 500s only in Azure (root `scripts` is tooling, `src/scripts` is runtime).

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Kept until the suite ends: the load test below unpacks the same zip the name checks read.
const PKG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'demi-pkg-'));
const PKG_ZIP = path.join(PKG_DIR, 'api.zip');
test.after(() => fs.rmSync(PKG_DIR, { recursive: true, force: true }));

/** Build the package once and return its entry list. */
function packagedEntries() {
  execFileSync('python3', [path.join(REPO_ROOT, 'scripts', 'package-api.py'), REPO_ROOT, PKG_ZIP], {
    stdio: 'pipe'
  });
  // `unzip -Z1` lists entry names without extracting — the package is ~26 MB and extracting it
  // for a name check would dominate the suite's runtime.
  const listing = execFileSync('unzip', ['-Z1', PKG_ZIP], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return new Set(listing.split('\n').filter(Boolean));
}

/** The minimum tree `package-api.py` accepts: entry points plus every required data directory. */
function scaffold(repo) {
  for (const d of ['api', 'azure/search/indexes', 'azure/search/indexers',
    'azure/search/datasources', 'frontend/public/assets/geojson']) {
    fs.mkdirSync(path.join(repo, d), { recursive: true });
  }
  for (const f of ['index.js', 'host.json', 'package.json']) {
    fs.writeFileSync(path.join(repo, f), '//');
  }
  fs.writeFileSync(path.join(repo, 'api', 'index.js'), '//');
  fs.writeFileSync(path.join(repo, 'azure/search/indexes', 'projects.json'), '{}');
  fs.writeFileSync(path.join(repo, 'azure/search/indexers', 'projects-indexer.json'), '{}');
  fs.writeFileSync(path.join(repo, 'azure/search/datasources', 'demi-projects-ds.json'), '{}');
  fs.writeFileSync(path.join(repo, 'azure/search', 'data-checks.json'), '{}');
  fs.writeFileSync(path.join(repo, 'frontend/public/assets/geojson', 'a.json'), '{}');
  // NESTED, because geojson is re-included from inside excluded `frontend`; blocking excluded
  // realpaths wholesale would empty it, and a flat fixture cannot tell.
  fs.mkdirSync(path.join(repo, 'frontend/public/assets/geojson', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'frontend/public/assets/geojson/nested', 'deep.geojson'), '{}');
}

/** Package `repo` and return its entry set. */
function packageInto(dir, repo) {
  const out = path.join(dir, 'api.zip');
  execFileSync('python3', [path.join(REPO_ROOT, 'scripts', 'package-api.py'), repo, out],
    { stdio: 'pipe', timeout: 60000 });
  return new Set(
    execFileSync('unzip', ['-Z1', out], { encoding: 'utf8' }).split('\n').filter(Boolean));
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
    // src/controllers/wildfire.js -> require('../scripts/sync-wildfires')
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

  await t.test('does NOT ship src/secret-sync or src/secret-rotator — those are separate function apps', () => {
    // Each has its own zip, package.json and dependencies; a copy inside the API package drifts from the live one.
    const appEntries = [...entries].filter(e => e.startsWith('src/secret-sync/') || e.startsWith('src/secret-rotator/'));
    assert.deepStrictEqual(
      appEntries,
      [],
      `separate apps must not be packaged, found: ${appEntries.join(', ')}`
    );
  });

  await t.test('does NOT ship pdf-title/ — a Python tool, not part of the API', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demi-pkg-pdf-title-'));
    const repo = path.join(dir, 'repo');
    scaffold(repo);
    fs.mkdirSync(path.join(repo, 'pdf-title'));
    fs.writeFileSync(path.join(repo, 'pdf-title', 'titler.py'), '#');

    const packed = packageInto(dir, repo);
    fs.rmSync(dir, { recursive: true, force: true });

    assert.deepStrictEqual([...packed].filter(e => e.startsWith('pdf-title/')), []);
  });

  await t.test('does NOT ship public/ — an untracked local build output', () => {
    // Nothing serves it, and zipdeploy merges into wwwroot, so one stale bundle from an operator's
    // working tree would stay there for good.
    const publicEntries = [...entries].filter(e => e.startsWith('public/'));
    assert.deepStrictEqual(
      publicEntries,
      [],
      `public/ must not be packaged, found: ${publicEntries.join(', ')}`
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

  await t.test('stamps build-id.txt at the zip root with BUILD_ID', () => {
    // config.js reads exactly this path, at zip root — a stamp that lands anywhere else, or under
    // any other name, reproduces the "unknown" build id this test exists to catch in advance.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demi-pkg-buildid-'));
    const repo = path.join(dir, 'repo');
    scaffold(repo);
    const sentinel = `test-build-${Date.now()}`;
    const out = path.join(dir, 'api.zip');
    execFileSync('python3', [path.join(REPO_ROOT, 'scripts', 'package-api.py'), repo, out],
      { stdio: 'pipe', env: { ...process.env, BUILD_ID: sentinel } });
    const content = execFileSync('unzip', ['-p', out, 'build-id.txt'], { encoding: 'utf8' });
    const mode = execFileSync('unzip', ['-Z', out, 'build-id.txt'], { encoding: 'utf8' });
    fs.rmSync(dir, { recursive: true, force: true });
    assert.strictEqual(content.trim(), sentinel,
      'build-id.txt at zip root must hold BUILD_ID');
    // writestr's default entry mode is unreadable to the Flex worker user (EACCES → "unknown").
    assert.match(mode, /^-rw-r--r--/m,
      'build-id.txt must be world-readable in the zip');
  });

  await t.test('ships a SYMLINKED node_modules, and does not loop on a cycle', () => {
    // Plain `os.walk` skips a symlinked node_modules silently: the zip deploys and cannot boot.
    // Plain `followlinks=True` recurses through loop-back until ELOOP, after writing duplicates.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demi-pkg-link-'));
    const repo = path.join(dir, 'repo');
    const store = path.join(dir, 'store');
    scaffold(repo);

    fs.mkdirSync(path.join(store, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(store, 'pkg', 'index.js'), '//');
    fs.symlinkSync(store, path.join(repo, 'node_modules'));
    // The cycle: a link inside the store pointing back at the repo root.
    fs.symlinkSync(repo, path.join(store, 'loop-back'));

    const linked = packageInto(dir, repo);
    fs.rmSync(dir, { recursive: true, force: true });

    assert.ok([...linked].some(e => e.startsWith('node_modules/')),
      'a symlinked node_modules must still be packaged');
    // The LINK BUDGET keeps this empty: `loop-back` sits inside the store, so it costs a second
    // link and is pruned. A one-hop link to the root IS followed once (next test).
    assert.deepStrictEqual([...linked].filter(e => e.includes('loop-back')), [],
      'a second link cannot be spent, so a loop reached through the store is not followed');
  });

  await t.test('a ONE-link loop back to the root is followed once, and stays bounded', () => {
    // Not a defect: the guarantee is the real tree plus one copy of each link target. What
    // matters is that the fences still hold on that copy.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demi-pkg-root-'));
    const repo = path.join(dir, 'repo');
    scaffold(repo);
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 's.js'), '//');
    fs.writeFileSync(path.join(repo, '.env'), 'SECRET=x');
    fs.mkdirSync(path.join(repo, '.claude', 'worktrees'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'worktrees', 'checkout.js'), '//');
    fs.symlinkSync('..', path.join(repo, 'src', 'back'));

    const packed = packageInto(dir, repo);
    fs.rmSync(dir, { recursive: true, force: true });

    const under = [...packed].filter(e => e.startsWith('src/back/'));
    assert.ok(under.length > 0, 'a one-link hop is within budget and is followed');
    assert.ok(under.length < 50, `and does not compound, got ${under.length}`);
    assert.deepStrictEqual([...packed].filter(e => e.includes('.env')), [],
      'the .env fence holds on the copy reached through the link');
    assert.deepStrictEqual([...packed].filter(e => e.includes('.claude')), [],
      'and so does the excluded-directory fence');
  });

  await t.test('keeps BOTH paths when two names resolve to one directory', () => {
    // The pnpm shape: Node resolves through both the link and `.pnpm/...` target, so both ship.
    // A global visited-set on realpaths would prune the whole store.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demi-pkg-pnpm-'));
    const repo = path.join(dir, 'repo');
    scaffold(repo);

    const store = path.join(repo, 'node_modules', '.pnpm', 'foo@1.0.0', 'node_modules', 'foo');
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(store, 'index.js'), '//');
    fs.symlinkSync(path.join('.pnpm', 'foo@1.0.0', 'node_modules', 'foo'),
      path.join(repo, 'node_modules', 'foo'));

    const packed = packageInto(dir, repo);
    fs.rmSync(dir, { recursive: true, force: true });

    assert.ok(packed.has('node_modules/foo/index.js'), 'the alias Node resolves through');
    assert.ok(packed.has('node_modules/.pnpm/foo@1.0.0/node_modules/foo/index.js'),
      'and the real store underneath it');
  });

  await t.test('a .env reached through a symlink is still refused', () => {
    // The re-include loop follows symlinks out of the data directories, so it must filter too.
    // Fixture-based: the real-tree '.env at any depth' test sees no .env in those directories.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demi-pkg-env-'));
    const repo = path.join(dir, 'repo');
    scaffold(repo);

    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, '.env'), 'MINIO_SECRET_KEY=leak');
    fs.writeFileSync(path.join(outside, '.env.production'), 'X=1');
    fs.writeFileSync(path.join(outside, 'regional_districts.geojson'), '{}');
    fs.symlinkSync(outside, path.join(repo, 'frontend/public/assets/geojson', 'linked'));

    const packed = packageInto(dir, repo);
    fs.rmSync(dir, { recursive: true, force: true });

    assert.deepStrictEqual([...packed].filter(e => e.includes('.env')), [],
      'no .env may reach the package, whatever path it arrived by');
    assert.ok(packed.has('frontend/public/assets/geojson/linked/regional_districts.geojson'),
      'and the data the link exists for must still ship');
  });

  await t.test('a symlink cannot re-admit an excluded directory', () => {
    // root_exclude_dirs applies at the repo root only, so a link elsewhere could re-admit an
    // excluded tree (e.g. `.claude/worktrees/*`, full checkouts) under its own name.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demi-pkg-fence-'));
    const repo = path.join(dir, 'repo');
    scaffold(repo);

    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.claude', 'worktrees', 'wt1'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'test', 'heavy'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'worktrees', 'wt1', 'checkout.js'), '//');
    fs.writeFileSync(path.join(repo, 'test', 'heavy', 'big.js'), '//');
    fs.symlinkSync(path.join('..', '.claude'), path.join(repo, 'src', 'link-to-claude'));
    fs.symlinkSync(path.join('..', 'test'), path.join(repo, 'src', 'link-to-test'));

    const packed = packageInto(dir, repo);
    fs.rmSync(dir, { recursive: true, force: true });

    assert.deepStrictEqual([...packed].filter(e => e.includes('link-to-')), [],
      'an exclusion is a fact about the directory, not about one name in the tree');
  });

  await t.test('a reconvergent symlink layout cannot blow the package up', () => {
    // An ACYCLIC graph where several paths reach one directory (workspaces, `link:` deps) is also
    // unbounded: a branch-only cycle guard enumerates every path, exit 0, no warning.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demi-pkg-dag-'));
    const repo = path.join(dir, 'repo');
    scaffold(repo);

    const LEVELS = 20;
    const pkgs = path.join(repo, 'packages');
    for (let i = 0; i <= LEVELS; i++) {
      fs.mkdirSync(path.join(pkgs, `p${i}`, 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(pkgs, `p${i}`, 'f.js'), '//');
    }
    // Each package links to the NEXT TWO, so paths reconverge without ever cycling.
    for (let i = 0; i <= LEVELS - 2; i++) {
      for (const j of [i + 1, i + 2]) {
        fs.symlinkSync(path.join('..', '..', `p${j}`),
          path.join(pkgs, `p${i}`, 'node_modules', `p${j}`));
      }
    }
    fs.symlinkSync('packages', path.join(repo, 'node_modules'));

    const packed = packageInto(dir, repo);
    fs.rmSync(dir, { recursive: true, force: true });

    // 21 real f.js files; a few hundred allows one copy per link. The failure is four orders of
    // magnitude away, so the exact ceiling is not delicate.
    assert.ok(packed.size < 500,
      `output must stay bounded on a reconvergent layout, got ${packed.size} entries`);
    assert.ok([...packed].some(e => e.startsWith('node_modules/')),
      'and it must still package what the link points at');
  });

  await t.test('follows a symlink inside a re-included data directory', () => {
    // The second walk() call site — the one that re-includes geojson and the index definitions.
    // Reverting it alone to os.walk left the whole suite green, so it was shipped untested.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demi-pkg-sub-'));
    const repo = path.join(dir, 'repo');
    scaffold(repo);

    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'regional_districts.geojson'), '{}');
    fs.symlinkSync(outside, path.join(repo, 'frontend/public/assets/geojson', 'linked'));

    const packed = packageInto(dir, repo);
    fs.rmSync(dir, { recursive: true, force: true });

    assert.ok(packed.has('frontend/public/assets/geojson/linked/regional_districts.geojson'),
      'a re-included data directory must be walked the same way as the rest of the tree');
    assert.ok(packed.has('frontend/public/assets/geojson/nested/deep.geojson'),
      'and its own subdirectories must survive — geojson sits under the excluded `frontend`, so ' +
      'applying the exclusion fence here unfiltered would empty the directory being re-included');
  });

  await t.test('ships the geojson the boundary seeder reads', () => {
    assert.ok(
      [...entries].some(e => e.startsWith('frontend/public/assets/geojson/')),
      'frontend is excluded wholesale, so the geojson re-include must still land'
    );
  });

  await t.test('ships the search index definitions — read at REQUIRE time by every route', () => {
    // eagle-query.js loads these at module scope, so a package without them ENOENTs the API.
    // Compared against disk, not a list, so an index the packager forgets is RED here.
    const onDisk = fs.readdirSync(path.join(REPO_ROOT, 'azure', 'search', 'indexes'))
      .filter(f => f.endsWith('.json'))
      .map(f => `azure/search/indexes/${f}`)
      .sort();
    assert.ok(onDisk.length > 0, 'the repo must hold index definitions for this test to mean anything');
    const packaged = [...entries].filter(e => e.startsWith('azure/search/indexes/')).sort();
    assert.deepStrictEqual(packaged, onDisk, 'every committed index definition must be packaged');

    // INDEXERS TOO: packaged apply-search-definitions.js reads them, and ENOENTs at
    // `load(INDEXER_DIR)` without them.
    const indexersOnDisk = fs.readdirSync(path.join(REPO_ROOT, 'azure', 'search', 'indexers'))
      .filter(f => f.endsWith('.json'))
      .map(f => `azure/search/indexers/${f}`)
      .sort();
    assert.ok(indexersOnDisk.length > 0, 'the repo must hold indexer definitions for this to mean anything');
    const packagedIndexers = [...entries].filter(e => e.startsWith('azure/search/indexers/')).sort();
    assert.deepStrictEqual(packagedIndexers, indexersOnDisk, 'every committed indexer definition must be packaged');

    // DATA SOURCES TOO: POST /admin/search-definitions/apply reads and PUTs them from this package.
    // No credential ships: `connectionString` is null on disk, composed at PUT time.
    const datasourcesOnDisk = fs.readdirSync(path.join(REPO_ROOT, 'azure', 'search', 'datasources'))
      .filter(f => f.endsWith('.json'))
      .map(f => `azure/search/datasources/${f}`)
      .sort();
    assert.ok(datasourcesOnDisk.length > 0, 'the repo must hold data source definitions for this to mean anything');
    const packagedDatasources = [...entries].filter(e => e.startsWith('azure/search/datasources/')).sort();
    assert.deepStrictEqual(packagedDatasources, datasourcesOnDisk, 'every committed data source must be packaged');

    // And none of them may carry a real connection string into a world-readable package.
    for (const entry of datasourcesOnDisk) {
      const ds = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, entry), 'utf8'));
      assert.strictEqual(ds.credentials.connectionString, null,
        `${entry} must ship with no connection string`);
    }
  });

  await t.test('does not ship non-runtime directories', () => {
    for (const dir of ['test/', '.github/', '.vscode/', '.claude/', '.git/']) {
      const hits = [...entries].filter(e => e.startsWith(dir));
      assert.deepStrictEqual(hits, [], `${dir} must not be packaged, found ${hits.length} entries`);
    }
    // Infra (Bicep, params, deploy templates) does not ship; `azure/` is checked separately
    // because the search definitions under it must.
    const azureExtras = [...entries]
      .filter(e => e.startsWith('azure/')
        && !e.startsWith('azure/search/indexes/')
        && !e.startsWith('azure/search/indexers/')
        && !e.startsWith('azure/search/datasources/')
        && e !== 'azure/search/data-checks.json');
    assert.deepStrictEqual(azureExtras, [],
      `only azure/search/{indexes,indexers,datasources,data-checks.json} may be packaged, found: ${azureExtras.join(', ')}`);
  });

  await t.test('every controller loads from the unpacked package', () => {
    // Controllers load lazily, so a dropped file one requires 500s only its route, only in Azure.
    // The name checks list known paths; this finds the next one nobody listed.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demi-pkg-unpacked-'));
    try {
      // node_modules is most of the zip and not what is under test; the repo's copy stands in.
      execFileSync('unzip', ['-q', PKG_ZIP, '-x', 'node_modules/*', '-d', dir]);
      fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(dir, 'node_modules'));
      // Listed from the working tree, not the zip, so a controller the packager drops is RED too.
      const controllers = fs.readdirSync(path.join(REPO_ROOT, 'src', 'controllers'), { recursive: true })
        .filter(f => f.endsWith('.js'))
        .map(f => path.join(dir, 'src', 'controllers', f));
      assert.ok(controllers.length > 0, 'the repo must hold controllers for this test to mean anything');
      const probe = `
        const failed = [];
        for (const f of ${JSON.stringify(controllers)}) {
          try { require(f); } catch (err) { failed.push(f.slice(${JSON.stringify(dir.length + 1)}) + ': ' + err.message.split('\\n')[0]); }
        }
        process.stdout.write('@@' + JSON.stringify(failed));
        process.exit(0);
      `;
      const out = execFileSync(process.execPath, ['-e', probe], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'test', APPLICATIONINSIGHTS_CONNECTION_STRING: '' }
      });
      const failed = JSON.parse(out.slice(out.indexOf('@@') + 2));
      assert.deepStrictEqual(failed, [], 'every controller must load from the packaged tree');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('never ships an operator credential file, at any depth', () => {
    // Same class as .env below. Fixture-based: the repo holds none of these, so a real-tree check
    // would pass whatever the packager did.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demi-pkg-secrets-'));
    const repo = path.join(dir, 'repo');
    scaffold(repo);
    fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
    const refused = ['local.settings.json', 'local.settings.example.json', '.npmrc', 'server.key', 'cert.pem',
      'bundle.p12', 'bundle.pfx'];
    for (const name of refused) {
      fs.writeFileSync(path.join(repo, name), 'SECRET=x');
      fs.writeFileSync(path.join(repo, 'src', 'deep', name), 'SECRET=x');
    }
    const packed = packageInto(dir, repo);
    fs.rmSync(dir, { recursive: true, force: true });
    const leaked = [...packed].filter(e => refused.includes(e.split('/').pop()));
    assert.deepStrictEqual(leaked, [], `no credential file may be packaged, found: ${leaked.join(', ')}`);
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
