'use strict';

/**
 * `src/scripts/probe-acl.js` is an operator script that only talks to a remote API over HTTP, so it
 * must run from a shell that has ENVIRONMENT exported — which is the natural state while probing
 * test. Reading ADMIN_API_KEY through src/config.js applied the server's DEMI_ALLOWED_CLIENTS boot
 * guard to it and killed the probe with an unrelated error before it ran.
 *
 * A child process, and no key: the script exits on its own guard before any request, so this case
 * proves the decoupling without reaching the network.
 */

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'src', 'scripts', 'probe-acl.js');

function run(vars) {
  const env = { ...process.env };
  // Whatever the runner's shell holds must not decide the case.
  delete env.ADMIN_API_KEY;
  Object.assign(env, vars);
  const res = spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 60000, env
  });
  return { status: res.status, output: `${res.stdout}${res.stderr}` };
}

test('the probe runs from a shell with ENVIRONMENT exported', () => {
  const { status, output } = run({ ENVIRONMENT: 'test', DEMI_ALLOWED_CLIENTS: '' });
  assert.ok(!/DEMI_ALLOWED_CLIENTS/.test(output),
    `the server boot guard must not reach this script; got:\n${output}`);
  assert.match(output, /ADMIN_API_KEY is not set/);
  assert.strictEqual(status, 2, 'a missing key aborts with 2');
});

test('an unresolved Key Vault reference is treated as no key', () => {
  // Sending the reference text would read back as a 401 and be reported as a broken ACL.
  const { status, output } = run({
    ADMIN_API_KEY: '@Microsoft.KeyVault(SecretUri=https://x.vault.azure.net/secrets/y)'
  });
  assert.match(output, /ADMIN_API_KEY is not set/);
  assert.strictEqual(status, 2);
});

test('listSees', async (t) => {
  const { listSees } = require(SCRIPT);

  /** Answers each request with the asked-for ids that `visible` holds, as the native list would. */
  function stubList(ctx, visible) {
    const urls = [];
    ctx.mock.method(globalThis, 'fetch', async (url) => {
      const parsed = new URL(url);
      urls.push(parsed);
      const rows = parsed.searchParams.get('ids').split(',')
        .filter(id => visible.includes(id)).map(id => ({ id }));
      return { status: 200, text: async () => JSON.stringify(rows) };
    });
    return urls;
  }

  await t.test('reads planted ids by id, in batches of at most 100, with no token', async (ctx) => {
    // Offset paging stops a caller with no credential at 2,000 rows, so only a by-id read makes a
    // zero mean "withheld" rather than "beyond the window".
    const ids = Array.from({ length: 150 }, (_, i) => `doc-${i}`);
    const urls = stubList(ctx, ['doc-3', 'doc-120']);

    const seen = await listSees(null, 'proj-1', ids);

    assert.strictEqual(seen, 2);
    assert.deepStrictEqual(urls.map(u => u.pathname), ['/api/documents', '/api/documents']);
    assert.deepStrictEqual(urls.map(u => u.searchParams.get('project')), ['proj-1', 'proj-1']);
    assert.deepStrictEqual(urls.map(u => u.searchParams.get('ids').split(',').length), [100, 50]);
    assert.deepStrictEqual(urls.map(u => u.searchParams.has('continuationToken')), [false, false]);
  });

  await t.test('reports a refused read as its status, not as a zero', async (ctx) => {
    ctx.mock.method(globalThis, 'fetch', async () => ({ status: 401, text: async () => '' }));

    assert.strictEqual(await listSees(null, 'proj-1', ['doc-1']), 'HTTP 401');
  });
});
