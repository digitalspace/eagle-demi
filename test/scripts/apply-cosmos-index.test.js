'use strict';

/**
 * `scripts/apply-cosmos-index.sh` applies one container's indexing policy from cosmos-nosql.bicep.
 * The first test compiles the real template; the rest stub `az` and `git` on PATH, so no network.
 */

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'apply-cosmos-index.sh');

const which = (cmd) => spawnSync('bash', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
const azOnPath = which('az').status === 0;
const REAL_DIFF = which('diff').stdout.trim();

test('extract reads the documents policy from the real cosmos-nosql.bicep', {
  skip: azOnPath ? false : 'az not on PATH, cannot compile bicep',
}, () => {
  const run = spawnSync('bash', [SCRIPT, 'extract', 'documents'], { encoding: 'utf8' });
  assert.strictEqual(run.status, 0, run.stderr);
  const policy = JSON.parse(run.stdout);
  const included = policy.includedPaths.map((p) => p.path);
  const excluded = policy.excludedPaths.map((p) => p.path);
  assert.ok(included.includes('/parentFieldsPending/?'));
  assert.ok(included.includes('/dateUploaded/?'));
  assert.ok(!included.includes('/*'));
  assert.ok(excluded.includes('/*'));
});

// `bicep build` prints $STUB_ARM; `container show` prints $STUB_LIVE; `container update` copies its
// @file over $STUB_LIVE unless FAKE_AZ_UPDATE_NOOP=1. Every call is logged with its full argv.
const FAKE_AZ = `#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
case "$1 $2 $4" in
  'bicep build '*) cat "$STUB_ARM" ;;
  'cosmosdb sql show')
    [ "\${FAKE_AZ_SHOW_FAIL:-0}" = 1 ] && { echo 'ERROR: Resource Not Found' >&2; exit 3; }
    cat "$STUB_LIVE" ;;
  'cosmosdb sql update')
    [ "\${FAKE_AZ_UPDATE_NOOP:-0}" = 1 ] && exit 0
    for a in "$@"; do case "$a" in @*) cp "\${a#@}" "$STUB_LIVE" ;; esac; done ;;
esac
`;

// Clean tree, fetch works, bicep same as origin/main by default. FAKE_GIT_DIRTY, FAKE_GIT_STATUS_FAIL,
// FAKE_GIT_FETCH_FAIL, FAKE_GIT_BICEP_DIFFERS, FAKE_GIT_DIFF_FAIL (each =1) flip one.
const FAKE_GIT = `#!/usr/bin/env bash
echo "$*" >> "$STUB_GIT_LOG"
[ "$1" = -C ] && shift 2
case "$1" in
  status)
    [ "\${FAKE_GIT_STATUS_FAIL:-0}" = 1 ] && exit 128
    [ "\${FAKE_GIT_DIRTY:-0}" = 1 ] && echo ' M azure/modules/cosmos-nosql.bicep'; exit 0 ;;
  fetch) [ "\${FAKE_GIT_FETCH_FAIL:-0}" != 1 ] ;;
  diff)
    [ "\${FAKE_GIT_DIFF_FAIL:-0}" = 1 ] && exit 128
    [ "\${FAKE_GIT_BICEP_DIFFERS:-0}" != 1 ] ;;
  *) exit 99 ;;
esac
`;

const FAKE_DIFF = `#!/usr/bin/env bash
[ "\${FAKE_DIFF_FAIL:-0}" = 1 ] && { echo 'diff: trouble' >&2; exit 2; }
exec ${REAL_DIFF} "$@"
`;

const CONTAINER_TYPE = 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers';
const PROD_TARGET = /--subscription be5924ac-1083-4a1b-be92-7b444882cfd9 -g rg-demi-prod -a demi-cosmos-prod -d demi -n documents/;

function resource(name, indexingPolicy) {
  return {
    type: CONTAINER_TYPE,
    name: `[format('{0}/{1}/{2}', variables('accountName'), variables('databaseName'), '${name}')]`,
    properties: { resource: { id: name, indexingPolicy } },
  };
}

// Shaped like the compiled template: format() names and an excludedPaths that is a variable reference.
function armWith(policies) {
  return {
    variables: { noIndex: [{ path: '/*' }, { path: '/_etag/?' }] },
    resources: Object.entries(policies).map(([name, policy]) => resource(name, policy)),
  };
}

const DECLARED = {
  indexingMode: 'consistent',
  automatic: true,
  includedPaths: [{ path: '/projectId/?' }, { path: '/dateUploaded/?' }],
  excludedPaths: "[variables('noIndex')]",
};

// What the service returns for DECLARED: nulls, empty arrays, its own path order.
const LIVE_SAME = {
  automatic: true,
  compositeIndexes: null,
  excludedPaths: [{ path: '/_etag/?' }, { path: '/*' }],
  fullTextIndexes: [],
  includedPaths: [{ indexes: null, path: '/dateUploaded/?' }, { indexes: null, path: '/projectId/?' }],
  indexingMode: 'consistent',
  spatialIndexes: null,
};

const LIVE_MISSING_DATE = { ...LIVE_SAME, includedPaths: [{ indexes: null, path: '/projectId/?' }] };

function stubRun(args, { arm = armWith({ documents: DECLARED }), live = LIVE_MISSING_DATE, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-cosmos-index-'));
  try {
    fs.writeFileSync(path.join(dir, 'az'), FAKE_AZ, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'git'), FAKE_GIT, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'diff'), FAKE_DIFF, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'arm.json'), JSON.stringify(arm));
    fs.writeFileSync(path.join(dir, 'live.json'), JSON.stringify(live));
    fs.writeFileSync(path.join(dir, 'az.log'), '');
    fs.writeFileSync(path.join(dir, 'git.log'), '');
    const run = spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CONFIRM_PROD: '',
        ...env,
        PATH: `${dir}:${process.env.PATH}`,
        STUB_ARM: path.join(dir, 'arm.json'),
        STUB_LIVE: path.join(dir, 'live.json'),
        STUB_LOG: path.join(dir, 'az.log'),
        STUB_GIT_LOG: path.join(dir, 'git.log'),
      },
    });
    return {
      ...run,
      azCalls: fs.readFileSync(path.join(dir, 'az.log'), 'utf8'),
      gitCalls: fs.readFileSync(path.join(dir, 'git.log'), 'utf8'),
      liveAfter: JSON.parse(fs.readFileSync(path.join(dir, 'live.json'), 'utf8')),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('dry run with drift prints the diff, exits 3, and never updates', () => {
  const run = stubRun(['test', 'documents']);
  assert.strictEqual(run.status, 3, run.stderr);
  assert.match(run.stdout, /^\+\s+"path": "\/dateUploaded\/\?"$/m);
  assert.match(run.stdout, /^dry run: would apply the declared policy to demi-cosmos-test\/demi\/documents; rerun with --live$/m);
  assert.doesNotMatch(run.stdout, /--idx|@\//);
  assert.doesNotMatch(run.azCalls, /container update/);
  assert.strictEqual(run.gitCalls, '');
});

test('a live policy equal up to nulls, empty arrays and path order is no change', () => {
  const run = stubRun(['test', 'documents'], { live: LIVE_SAME });
  assert.strictEqual(run.status, 0, run.stderr);
  assert.match(run.stdout, /^no change/m);
  assert.doesNotMatch(run.stdout, /^[+-]\s/m);
});

const GEO_DECLARED = {
  indexingMode: 'consistent',
  includedPaths: [{ path: '/*' }],
  spatialIndexes: [{ path: '/geometry/*', types: ['Point', 'Polygon'] }],
  compositeIndexes: [
    [{ path: '/a', order: 'ascending' }, { path: '/b', order: 'descending' }],
    [{ path: '/c', order: 'ascending' }, { path: '/d', order: 'ascending' }],
  ],
};

test('spatial types and composite index order are no change when only their order differs', () => {
  const live = {
    ...GEO_DECLARED,
    spatialIndexes: [{ path: '/geometry/*', types: ['Polygon', 'Point'] }],
    compositeIndexes: [
      [{ order: 'ascending', path: '/c' }, { order: 'ascending', path: '/d' }],
      [{ order: 'ascending', path: '/a' }, { order: 'descending', path: '/b' }],
    ],
  };
  const run = stubRun(['test', 'geo'], { arm: armWith({ geo: GEO_DECLARED }), live });
  assert.strictEqual(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^no change/m);
});

test('paths inside one composite index keep their order', () => {
  const live = {
    ...GEO_DECLARED,
    compositeIndexes: [
      [{ path: '/b', order: 'descending' }, { path: '/a', order: 'ascending' }],
      GEO_DECLARED.compositeIndexes[1],
    ],
  };
  const run = stubRun(['test', 'geo'], { arm: armWith({ geo: GEO_DECLARED }), live });
  assert.strictEqual(run.status, 3, run.stderr);
});

test('--live applies the declared policy to the named account and confirms it', () => {
  const run = stubRun(['test', 'documents', '--live']);
  assert.strictEqual(run.status, 0, run.stderr);
  assert.match(run.azCalls, /container update --subscription 7897ceb1-9a86-4639-87d7-7f9ff67142b3 -g c4b0a8-test-rg -a demi-cosmos-test -d demi -n documents --idx @/);
  assert.deepStrictEqual(run.liveAfter.includedPaths.map((p) => p.path).sort(), ['/dateUploaded/?', '/projectId/?']);
  assert.match(run.stdout, /^applied/m);
  assert.doesNotMatch(run.stderr, /WARNING/);
  assert.match(run.gitCalls, /status --porcelain -- azure\/modules\/cosmos-nosql\.bicep/);
  assert.doesNotMatch(run.gitCalls, /fetch|diff/);
});

test('--live warns before removing an index path, then applies', () => {
  const live = { ...LIVE_SAME, includedPaths: [...LIVE_SAME.includedPaths, { path: '/old/?' }] };
  const run = stubRun(['test', 'documents', '--live'], { live });
  assert.strictEqual(run.status, 0, run.stderr);
  assert.match(run.stderr, /^WARNING: removes index paths$/m);
  assert.match(run.azCalls, /container update/);
});

test('--live refuses while cosmos-nosql.bicep has uncommitted changes', () => {
  const run = stubRun(['test', 'documents', '--live'], { env: { FAKE_GIT_DIRTY: '1' } });
  assert.strictEqual(run.status, 2);
  assert.match(run.stderr, /cosmos-nosql\.bicep has uncommitted changes/);
  assert.strictEqual(run.azCalls, '');
});

test('--live refuses when git status fails instead of reading a clean tree', () => {
  const run = stubRun(['test', 'documents', '--live'], { env: { FAKE_GIT_STATUS_FAIL: '1' } });
  assert.strictEqual(run.status, 2);
  assert.match(run.stderr, /git status failed \(exit 128\)/);
  assert.strictEqual(run.azCalls, '');
});

test('--live exits 1 when the live policy still differs after the update', () => {
  const run = stubRun(['test', 'documents', '--live'], { env: { FAKE_AZ_UPDATE_NOOP: '1' } });
  assert.strictEqual(run.status, 1);
  assert.match(run.stderr, /still differs/);
  assert.match(run.azCalls, /container update/);
});

test('prod --live with CONFIRM_PROD=yes and bicep equal to origin/main applies to the prod account', () => {
  const run = stubRun(['prod', 'documents', '--live'], { env: { CONFIRM_PROD: 'yes' } });
  assert.strictEqual(run.status, 0, run.stderr);
  const calls = run.azCalls.split('\n');
  const show = calls.filter((c) => c.startsWith('cosmosdb sql container show'));
  const update = calls.filter((c) => c.startsWith('cosmosdb sql container update'));
  assert.strictEqual(show.length, 2);
  assert.strictEqual(update.length, 1);
  for (const call of [...show, ...update]) assert.match(call, PROD_TARGET);
  const gitArgv = run.gitCalls.trim().split('\n').map((c) => c.replace(/^-C \S+ /, ''));
  assert.deepStrictEqual(gitArgv, [
    'status --porcelain -- azure/modules/cosmos-nosql.bicep',
    'fetch -q origin main',
    'diff --quiet origin/main -- azure/modules/cosmos-nosql.bicep',
  ]);
});

// A stale checkout of main passes an ancestry check but can still drop an index prod already has.
test('prod --live refuses a merged HEAD whose bicep differs from origin/main', () => {
  const run = stubRun(['prod', 'documents', '--live'], { env: { CONFIRM_PROD: 'yes', FAKE_GIT_BICEP_DIFFERS: '1' } });
  assert.strictEqual(run.status, 2);
  assert.match(run.stderr, /cosmos-nosql\.bicep differs from origin\/main; merge or check out main first/);
  assert.strictEqual(run.azCalls, '');
});

test('prod --live refuses when git diff against origin/main errors', () => {
  const run = stubRun(['prod', 'documents', '--live'], { env: { CONFIRM_PROD: 'yes', FAKE_GIT_DIFF_FAIL: '1' } });
  assert.strictEqual(run.status, 2);
  assert.match(run.stderr, /git diff against origin\/main failed \(exit 128\)/);
  assert.strictEqual(run.azCalls, '');
});

test('prod --live refuses when git fetch origin main fails', () => {
  const run = stubRun(['prod', 'documents', '--live'], { env: { CONFIRM_PROD: 'yes', FAKE_GIT_FETCH_FAIL: '1' } });
  assert.strictEqual(run.status, 2);
  assert.match(run.stderr, /git fetch origin main failed/);
  assert.doesNotMatch(run.gitCalls, /diff/);
  assert.strictEqual(run.azCalls, '');
});

for (const confirm of ['', 'YES', 'true']) {
  test(`prod --live refuses with CONFIRM_PROD='${confirm}' and calls nothing`, () => {
    const run = stubRun(['prod', 'documents', '--live'], { env: { CONFIRM_PROD: confirm } });
    assert.strictEqual(run.status, 2);
    assert.match(run.stderr, /CONFIRM_PROD=yes/);
    assert.strictEqual(run.azCalls, '');
    assert.strictEqual(run.gitCalls, '');
  });
}

test('prod dry run needs no CONFIRM_PROD and reads the prod account', () => {
  const run = stubRun(['prod', 'documents']);
  assert.strictEqual(run.status, 3, run.stderr);
  assert.match(run.azCalls, PROD_TARGET);
  assert.doesNotMatch(run.azCalls, /container update/);
});

test('a container missing on the account fails and says it may be conditional', () => {
  const run = stubRun(['test', 'documents'], { env: { FAKE_AZ_SHOW_FAIL: '1' } });
  assert.strictEqual(run.status, 1);
  assert.match(run.stderr, /container documents not found on demi-cosmos-test \(it may be conditional in bicep\)/);
});

test('a diff error exits 2 instead of reading as drift', () => {
  const run = stubRun(['test', 'documents', '--live'], { env: { FAKE_DIFF_FAIL: '1' } });
  assert.strictEqual(run.status, 2);
  assert.match(run.stderr, /diff failed \(exit 2\)/);
  assert.doesNotMatch(run.azCalls, /container update/);
});

test('an unknown container fails and names it', () => {
  const run = stubRun(['test', 'nope']);
  assert.strictEqual(run.status, 1);
  assert.match(run.stderr, /container 'nope' not found/);
  assert.doesNotMatch(run.azCalls, /cosmosdb/);
});

test('a container declared twice fails before reading live', () => {
  const arm = armWith({});
  arm.resources = [resource('documents', DECLARED), resource('documents', DECLARED)];
  const run = stubRun(['test', 'documents'], { arm });
  assert.strictEqual(run.status, 1);
  assert.match(run.stderr, /container 'documents' declared 2 times/);
  assert.doesNotMatch(run.azCalls, /cosmosdb/);
});

test('a container with no indexingPolicy fails before reading live', () => {
  const run = stubRun(['test', 'documents'], { arm: armWith({ documents: null }) });
  assert.strictEqual(run.status, 1);
  assert.match(run.stderr, /container 'documents' declares no indexingPolicy/);
  assert.doesNotMatch(run.azCalls, /cosmosdb/);
});

test('a policy with an unresolved ARM expression fails before reading live', () => {
  const arm = armWith({
    documents: { ...DECLARED, excludedPaths: "[concat(variables('noIndex'), createArray())]" },
  });
  const run = stubRun(['test', 'documents'], { arm });
  assert.strictEqual(run.status, 1);
  assert.match(run.stderr, /unresolved ARM expressions: \[concat/);
  assert.doesNotMatch(run.azCalls, /cosmosdb/);
});

for (const [name, args, message] of [
  ['an unknown environment', ['dev', 'documents'], /unknown environment 'dev'/],
  ['an unknown third argument', ['test', 'documents', '--force'], /unknown argument '--force'/],
  ['a fourth argument', ['test', 'documents', '--live', 'extra'], /^Usage:/m],
]) {
  test(`${name} exits 2 and calls nothing`, () => {
    const run = stubRun(args);
    assert.strictEqual(run.status, 2);
    assert.match(run.stderr, message);
    assert.strictEqual(run.azCalls, '');
    assert.strictEqual(run.gitCalls, '');
  });
}
