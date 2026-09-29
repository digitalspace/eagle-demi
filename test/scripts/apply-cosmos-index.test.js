'use strict';

/**
 * `scripts/apply-cosmos-index.sh` applies one container's indexing policy from cosmos-nosql.bicep.
 * The first test compiles the real template; the rest put a stub `az` on PATH, so they need no
 * Azure login and touch no network.
 */

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'apply-cosmos-index.sh');

const azOnPath = spawnSync('bash', ['-c', 'command -v az'], { encoding: 'utf8' }).status === 0;

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
// @file over $STUB_LIVE, so the re-read after an update sees what was applied. Every call is logged.
const FAKE_AZ = `#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
case "$1 $2 $4" in
  'bicep build '*) cat "$STUB_ARM" ;;
  'cosmosdb sql show') cat "$STUB_LIVE" ;;
  'cosmosdb sql update')
    for a in "$@"; do case "$a" in @*) cp "\${a#@}" "$STUB_LIVE" ;; esac; done ;;
esac
`;

const CONTAINER_TYPE = 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers';

// Shaped like the compiled template: format() names and an excludedPaths that is a variable reference.
function armWith(policies) {
  return {
    variables: { noIndex: [{ path: '/*' }, { path: '/_etag/?' }] },
    resources: Object.entries(policies).map(([name, indexingPolicy]) => ({
      type: CONTAINER_TYPE,
      name: `[format('{0}/{1}/{2}', variables('accountName'), variables('databaseName'), '${name}')]`,
      properties: { resource: { id: name, indexingPolicy } },
    })),
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
    fs.writeFileSync(path.join(dir, 'arm.json'), JSON.stringify(arm));
    fs.writeFileSync(path.join(dir, 'live.json'), JSON.stringify(live));
    fs.writeFileSync(path.join(dir, 'az.log'), '');
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
      },
    });
    return {
      ...run,
      azCalls: fs.readFileSync(path.join(dir, 'az.log'), 'utf8'),
      liveAfter: JSON.parse(fs.readFileSync(path.join(dir, 'live.json'), 'utf8')),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('dry run prints the diff and the update command, and never updates', () => {
  const run = stubRun(['test', 'documents']);
  assert.strictEqual(run.status, 0, run.stderr);
  assert.match(run.stdout, /^\+\s+"path": "\/dateUploaded\/\?"$/m);
  assert.match(run.stdout, /az cosmosdb sql container update .*-a demi-cosmos-test -d demi -n documents --idx @/);
  assert.doesNotMatch(run.azCalls, /container update/);
});

test('a live policy equal up to nulls, empty arrays and path order is no change', () => {
  const run = stubRun(['test', 'documents'], { live: LIVE_SAME });
  assert.strictEqual(run.status, 0, run.stderr);
  assert.match(run.stdout, /^no change/m);
  assert.doesNotMatch(run.stdout, /^[+-]\s/m);
});

test('--live applies the declared policy to the named account and confirms it', () => {
  const run = stubRun(['test', 'documents', '--live']);
  assert.strictEqual(run.status, 0, run.stderr);
  assert.match(run.azCalls, /container update --subscription 7897ceb1-9a86-4639-87d7-7f9ff67142b3 -g c4b0a8-test-rg -a demi-cosmos-test -d demi -n documents --idx @/);
  assert.deepStrictEqual(run.liveAfter.includedPaths.map((p) => p.path).sort(), ['/dateUploaded/?', '/projectId/?']);
  assert.match(run.stdout, /^applied/m);
});

test('prod --live refuses without CONFIRM_PROD=yes and calls nothing', () => {
  const run = stubRun(['prod', 'documents', '--live']);
  assert.strictEqual(run.status, 2);
  assert.match(run.stderr, /CONFIRM_PROD=yes/);
  assert.strictEqual(run.azCalls, '');
});

test('an unknown container fails and names it', () => {
  const run = stubRun(['test', 'nope']);
  assert.strictEqual(run.status, 1);
  assert.match(run.stderr, /container 'nope' not found/);
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
