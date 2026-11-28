'use strict';

/**
 * A function turned on by an app setting registers only at the next code deploy, so after an infra
 * deploy the check must name what is missing and how to re-run. `az` is a fake first on PATH.
 */

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadIndex, SCHEDULE_VARS } = require('../helpers/load-index');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-api-functions.sh');

const FAKE_AZ = `#!/usr/bin/env bash
echo "$*" >> "\${AZ_LOG}"
case "$*" in
  *"config appsettings list"*)
    for kv in \${FAKE_SETTINGS}; do
      # The real list keeps a setting deployed as ''; only the \`[?value]\` filter drops it.
      case "$*" in *'[?value].name'*) [ -n "\${kv#*=}" ] || continue ;; esac
      echo "\${kv%%=*}"
    done ;;
  *"function list"*) printf '%s\\n' \${FAKE_FUNCTIONS} ;;
esac
`;

/** The subscription id the script resolves, read from the same file rather than copied here. */
function subscriptionFor(env) {
  const res = spawnSync('bash', ['-c', `source scripts/lib/azure-env.sh && demi_azure_env ${env} && echo "$SUBSCRIPTION"`],
    { cwd: ROOT, encoding: 'utf8' });
  return res.stdout.trim();
}

/** Run the check for `env` against a fake az holding `settings` ({name: value}) and `functions`. */
function run(env, { settings, functions }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caf-'));
  const log = path.join(dir, 'az.log');
  fs.writeFileSync(path.join(dir, 'az'), FAKE_AZ, { mode: 0o755 });
  fs.writeFileSync(log, '');

  const res = spawnSync('bash', [SCRIPT, env], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      AZ_LOG: log,
      FAKE_SETTINGS: Object.entries(settings).map(([name, value]) => `${name}=${value}`).join(' '),
      // Flex prints names with the app prefix.
      FAKE_FUNCTIONS: functions.map(f => `demi-api-fc-${env}/${f}`).join(' ')
    }
  });

  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...res, calls };
}

/** The `SETTING=function` rows of the script's GUARDED table. */
function guardedRows() {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  const block = text.match(/^GUARDED=\(\n([\s\S]*?)^\)/m)[1];
  return block.trim().split('\n').map(line => line.trim().split('='));
}

/** Every function name `api/index.js` registered in one load. */
const registeredNames = ({ registered }) =>
  [...registered.timers, ...registered.queues, ...registered.https, ...registered.eventGrids].map(r => r.name);

test('check-api-functions.sh', async (t) => {
  await t.test('on test, names a function whose setting is on but which is not registered', () => {
    const r = run('test', {
      settings: { FUNCTIONS_EXTENSION_VERSION: '~4', INTAKE_STORAGE_ACCOUNT: 'acct' },
      functions: ['api']
    });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /intakeScanSweep/);
    assert.match(r.stderr, /azure-deploy-staging-api\.yaml/);
  });

  await t.test('on prod, names the prod workflow and reads only the prod subscription', () => {
    const sub = subscriptionFor('prod');
    const r = run('prod', { settings: { INTAKE_STORAGE_ACCOUNT: 'acct' }, functions: ['api'] });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /azure-deploy-prod\.yaml/);
    assert.ok(r.calls.length > 0);
    assert.deepStrictEqual(r.calls.filter(c => !c.includes(`--subscription ${sub}`)), []);
  });

  await t.test('passes and lists the registered names when nothing is missing', () => {
    const r = run('test', {
      settings: { EDGE_BAN_MODE: 'off', INTAKE_STORAGE_ACCOUNT: 'acct' },
      functions: ['api', 'apiRoot', 'edgeBan', 'intakeScanSweep']
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /^ {2}intakeScanSweep$/m);
    assert.match(r.stdout, /^ {2}edgeBan$/m);
  });

  await t.test('treats a setting deployed empty as off', () => {
    const r = run('test', { settings: { RECONCILE_SCHEDULE: '' }, functions: ['api'] });
    assert.strictEqual(r.status, 0, r.stderr);
  });

  await t.test('the table covers every setting that registers a trigger', () => {
    assert.deepStrictEqual(guardedRows().map(([setting]) => setting).sort(), [...SCHEDULE_VARS].sort());
  });

  for (const [setting, fn] of guardedRows()) {
    await t.test(`${setting} registers ${fn}`, (st) => {
      // Deployed apps set EDGE_BAN_MODE to `off`, which still registers the timer.
      const names = registeredNames(loadIndex(st, setting, setting === 'EDGE_BAN_MODE' ? 'off' : 'x'));
      assert.ok(names.includes(fn), `${setting} registered ${names.join(', ')}`);
    });

    await t.test(`${fn} is not registered with every setting unset`, (st) => {
      assert.ok(!registeredNames(loadIndex(st)).includes(fn));
    });
  }
});
