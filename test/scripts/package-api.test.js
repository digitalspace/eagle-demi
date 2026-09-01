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

/** The minimum tree `package-api.py` accepts: entry points plus every required data directory. */
function scaffold(repo) {
  for (const d of ['api', 'azure/search/indexes', 'azure/search/indexers',
    'frontend/public/assets/geojson']) {
    fs.mkdirSync(path.join(repo, d), { recursive: true });
  }
  for (const f of ['index.js', 'host.json', 'package.json']) {
    fs.writeFileSync(path.join(repo, f), '//');
  }
  fs.writeFileSync(path.join(repo, 'api', 'index.js'), '//');
  fs.writeFileSync(path.join(repo, 'azure/search/indexes', 'projects.json'), '{}');
  fs.writeFileSync(path.join(repo, 'azure/search/indexers', 'projects-indexer.json'), '{}');
  fs.writeFileSync(path.join(repo, 'frontend/public/assets/geojson', 'a.json'), '{}');
  // A NESTED directory, because a re-included path lives under an excluded one — geojson is
  // inside `frontend`. Blocking the excluded realpaths wholesale in the re-include walk would
  // empty exactly this, and a flat fixture cannot tell the two apart.
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

  await t.test('does NOT ship public/ — an untracked local build output', () => {
    // Nothing serves it since the static mounts left src/app.js, and zipdeploy merges into
    // wwwroot, so packaging a stale bundle once would leave it there permanently. This packager
    // runs from the operator's working tree, which is exactly where a stale build lives.
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
    // `os.walk` does not descend into a symlinked directory and says nothing when it skips one.
    // Point node_modules at a store — a pnpm linker, a shared install, a git worktree borrowing one
    // to avoid a 300 MB reinstall — and the packager walked past it, exited 0, and produced a zip
    // that deploys and then cannot boot: the app has no route to a registry to npm install from.
    // Measured against the real packager before the fix: zero node_modules/ entries, exit 0.
    //
    // The cycle half is not decoration. `followlinks=True` on its own re-packages the tree under
    // node_modules/loop-back/node_modules/loop-back/... until the kernel raises ELOOP and the
    // packager dies — after it has already written the duplicates.
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
    // What actually keeps this empty is the LINK BUDGET, not any rule about links to the root:
    // `loop-back` sits inside the store, so reaching it costs a second link and it is pruned.
    // An earlier message here claimed a root-loop-back guarantee the code does not make — see the
    // next test, where a link back to the root costs only one and IS followed, once.
    assert.deepStrictEqual([...linked].filter(e => e.includes('loop-back')), [],
      'a second link cannot be spent, so a loop reached through the store is not followed');
  });

  await t.test('a ONE-link loop back to the root is followed once, and stays bounded', () => {
    // Not a defect, and written down so nobody "fixes" it into one. The guarantee is the real tree
    // plus one copy of each link target — so a link costing a single hop is followed, and the
    // budget stops it compounding. What matters is that the fences still hold on that copy.
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
    // The pnpm shape, and the case that makes a global visited-set wrong. `node_modules/foo` is a
    // link into `node_modules/.pnpm/foo@1.0.0/node_modules/foo`; Node resolves through both, so
    // both have to ship. Marking the realpath seen at the shallower name pruned the whole store —
    // measured, and it was content the previous version of the packager did include.
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
    // The re-include loop wrote whatever it walked with NO filtering at all — survivable only
    // while it could not leave the three checked-in data directories. Following symlinks ended
    // that. The existing '.env at any depth' test cannot catch this: it inspects the real repo's
    // package, and there are no .env files in those directories today, so the hole was latent.
    // The packager's own comment records a packaged .env carrying MONGODB_PASSWORD,
    // TYPESENSE_API_KEY, MINIO_SECRET_KEY and DOCLING_API_KEY into a world-readable wwwroot path.
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
    // root_exclude_dirs is applied by position — only at the repo root — so a link anywhere else
    // re-admitted the excluded tree under the link's own name. `.claude/worktrees/*` are full
    // checkouts of this repository; shipping them once made a 202 MB package that left Kudu at
    // status 1 for over thirty minutes against a normal thirty seconds.
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
    // Cycles are not the only unbounded shape. In an ACYCLIC graph where several paths reach the
    // same directory — what workspaces and `link:` deps produce — a guard that only refuses to
    // re-enter the CURRENT branch still enumerates every distinct path through the graph.
    // Measured on this fixture at 20 levels: 114,590 entries and a 58 MB zip from 22 real
    // directories, exit 0, no warning. The packager's own comments record what an oversized
    // package did to Kudu: status 1 for over thirty minutes against a normal thirty seconds.
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

    // The real tree holds 21 f.js files. A few hundred allows the one permitted copy per link;
    // the failure this pins is four orders of magnitude away, so the exact ceiling is not
    // delicate — what matters is that SOME ceiling exists.
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
    // `src/search/eagle-query.js` runs `const FIELDS = loadFields()` at module scope, and
    // src/http/routes.js -> src/controllers/search.js reaches it on the first search. A package without
    // these does not degrade search, it kills the whole API on startup with an ENOENT on a
    // scandir. That shipped once: `azure/` is excluded as infra and the definitions live under it.
    //
    // Compared against what is on disk rather than a hardcoded list, so a fourth index added to
    // the repo and forgotten by the packager is RED here rather than a boot loop in Azure. The
    // two sides are independent — the zip is built by package-api.py, this side is the working
    // tree — so this cannot pass by agreeing with itself.
    const onDisk = fs.readdirSync(path.join(REPO_ROOT, 'azure', 'search', 'indexes'))
      .filter(f => f.endsWith('.json'))
      .map(f => `azure/search/indexes/${f}`)
      .sort();
    assert.ok(onDisk.length > 0, 'the repo must hold index definitions for this test to mean anything');
    const packaged = [...entries].filter(e => e.startsWith('azure/search/indexes/')).sort();
    assert.deepStrictEqual(packaged, onDisk, 'every committed index definition must be packaged');

    // INDEXERS TOO. This assertion did not exist when `indexes` was re-included, and the gap was
    // not theoretical: apply-search-definitions.js IS packaged and read them, so it died at
    // `load(INDEXER_DIR)` with ENOENT before issuing a single request, on dry run and --live alike.
    const indexersOnDisk = fs.readdirSync(path.join(REPO_ROOT, 'azure', 'search', 'indexers'))
      .filter(f => f.endsWith('.json'))
      .map(f => `azure/search/indexers/${f}`)
      .sort();
    assert.ok(indexersOnDisk.length > 0, 'the repo must hold indexer definitions for this to mean anything');
    const packagedIndexers = [...entries].filter(e => e.startsWith('azure/search/indexers/')).sort();
    assert.deepStrictEqual(packagedIndexers, indexersOnDisk, 'every committed indexer definition must be packaged');

    // DATA SOURCES MUST NOT SHIP. connectionString comes back redacted on export, so the committed
    // copy could only restore a broken one — and nothing reads them at runtime.
    const packagedDatasources = [...entries].filter(e => e.startsWith('azure/search/datasources/'));
    assert.deepStrictEqual(packagedDatasources, [], 'data source definitions must not be packaged');
  });

  await t.test('does not ship non-runtime directories', () => {
    for (const dir of ['test/', '.github/', '.vscode/', '.claude/', '.git/']) {
      const hits = [...entries].filter(e => e.startsWith(dir));
      assert.deepStrictEqual(hits, [], `${dir} must not be packaged, found ${hits.length} entries`);
    }
    // `azure/` was in that list, asserting it ships NOTHING. The point of that assertion — infra
    // does not ship; Bicep, parameter files and deploy templates are not runtime, and shipping
    // them is how wwwroot ended up holding a copy of the repository — survives, narrowed to
    // everything BUT the index definitions above. The blanket form was itself the bug: it locked
    // in an exclusion that the search query builder had since grown a hard dependency on.
    const azureExtras = [...entries]
      .filter(e => e.startsWith('azure/')
        && !e.startsWith('azure/search/indexes/')
        && !e.startsWith('azure/search/indexers/'));
    assert.deepStrictEqual(azureExtras, [],
      `only azure/search/{indexes,indexers} may be packaged, found: ${azureExtras.join(', ')}`);
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
