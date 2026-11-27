'use strict';

// probe-acl.js must not load src/config.js, whose server boot guards would kill it in an operator
// shell. Run with no key, it exits on its own guard before any request.

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

test('plant', async (t) => {
  const saved = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = 'probe-test-admin';
  delete require.cache[SCRIPT];
  const { plant } = require(SCRIPT);
  t.after(() => {
    if (saved === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = saved;
    delete require.cache[SCRIPT];
  });

  /** Intake as the live API answers it: each upload reads `pending` `pendingPolls` times, then `settled`. */
  function stubIntake(ctx, pendingPolls, settled = 'clean') {
    const calls = [];
    const polls = new Map();
    let next = 0;
    const reply = (status, json) => ({ status, text: async () => (json ? JSON.stringify(json) : '') });
    ctx.mock.method(globalThis, 'fetch', async (url, init = {}) => {
      const parsed = new URL(url);
      const json = init.headers['Content-Type'] === 'application/json';
      calls.push({ method: init.method, host: parsed.host, path: parsed.pathname, headers: init.headers,
        body: json ? JSON.parse(init.body) : init.body });
      if (parsed.host === 'intake.example') return reply(201);
      if (parsed.pathname === '/api/intake/uploads') {
        next += 1;
        return reply(201, { documentId: `doc-${next}`, uploadUrl: `https://intake.example/incoming/doc-${next}?sig=x` });
      }
      const status = /^\/api\/intake\/uploads\/(.+)$/.exec(parsed.pathname);
      if (status) {
        const seen = (polls.get(status[1]) || 0) + 1;
        polls.set(status[1], seen);
        calls[calls.length - 1].scanStatus = seen > pendingPolls ? settled : 'pending';
        return reply(200, { scanStatus: calls[calls.length - 1].scanStatus, scanRejectReason: 'infected' });
      }
      return reply(200, {});
    });
    return calls;
  }

  const rows = [
    { projectId: 'proj-a', label: 'hidden', publish: false },
    { projectId: 'proj-a', label: 'control', publish: true }
  ];

  await t.test('uploads through intake, waits for clean, then raises only the public row', async (ctx) => {
    const calls = stubIntake(ctx, 1);
    const created = [];

    const ids = await plant(rows, { term: 'zz', created, waitMs: 1000, pollMs: 1 });

    assert.deepStrictEqual(ids, ['doc-1', 'doc-2']);
    assert.deepStrictEqual(created.map(c => [c.id, c.clean]), [['doc-1', true], ['doc-2', true]]);
    const creates = calls.filter(c => c.path === '/api/intake/uploads');
    assert.deepStrictEqual(creates.map(c => c.body.projectId), ['proj-a', 'proj-a']);
    const uploads = calls.filter(c => c.host === 'intake.example');
    assert.deepStrictEqual(uploads.map(c => c.method), ['PUT', 'PUT']);
    assert.ok(uploads.every(c => !('X-Api-Key' in c.headers)), 'the upload link must not carry the admin key');
    const raises = calls.filter(c => c.path.endsWith('/level'));
    assert.deepStrictEqual(raises.map(c => [c.method, c.path, c.body.level, c.body.confirm]),
      [['PUT', '/api/documents/doc-2/level', 4, true]]);
    // The live API refuses to raise a row that has not cleared its scan.
    const before = calls.slice(0, calls.indexOf(raises[0])).filter(c => c.path === '/api/intake/uploads/doc-2');
    assert.strictEqual(before.at(-1).scanStatus, 'clean', 'the raise waits until the row reads clean');
  });

  await t.test('stops with an error when a row never reads clean', async (ctx) => {
    stubIntake(ctx, Infinity);
    const created = [];

    await assert.rejects(plant(rows, { term: 'zz', created, waitMs: 5, pollMs: 1 }), /not clean within/);
    // Cleanup skips them: DELETE cannot reach a row that never cleared its scan.
    assert.deepStrictEqual(created.map(c => c.clean), [false, false]);
  });

  await t.test('stops at once with the reason when a scan is rejected', async (ctx) => {
    stubIntake(ctx, 0, 'rejected');

    await assert.rejects(plant(rows, { term: 'zz', created: [], waitMs: 60000, pollMs: 1 }),
      /scan rejected hidden: infected/);
  });
});
