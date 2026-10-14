'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('node:child_process');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'logger', 'throws-at-load.js');

function run(args, extraEnv) {
  // An inherited quieter LOG_LEVEL would hide the logged exception the last case looks for.
  const env = { ...process.env, LOG_LEVEL: 'info', ...extraEnv };
  // The outer runner sets this for its own child; the spawned process must start fresh.
  delete env.NODE_TEST_CONTEXT;
  if (!('NODE_ENV' in extraEnv)) delete env.NODE_ENV;
  const result = spawnSync(process.execPath, [...args, FIXTURE], { env, encoding: 'utf8', timeout: 30000 });
  // A hung or killed child has no exit status, and must not read as a non-zero one.
  assert.strictEqual(result.error, undefined, String(result.error));
  assert.strictEqual(result.signal, null, `child ended by ${result.signal}`);
  return { status: result.status, output: result.stdout + result.stderr };
}

test('logger does not swallow an exception thrown while a test file loads', async (t) => {
  await t.test('node --test reports the file as failed', () => {
    const { status, output } = run(['--test'], {});
    assert.notStrictEqual(status, 0, output);
    assert.match(output, /fixture: thrown at load/);
  });

  await t.test('NODE_ENV=test exits non-zero when run directly', () => {
    const { status, output } = run([], { NODE_ENV: 'test' });
    assert.notStrictEqual(status, 0, output);
    assert.match(output, /fixture: thrown at load/);
  });
});

test('outside tests the logger logs an uncaught exception and keeps the process alive', () => {
  const { status, output } = run([], {});
  assert.strictEqual(status, 0, output);
  assert.match(output, /uncaughtException: fixture: thrown at load/);
});
