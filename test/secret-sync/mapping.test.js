'use strict';

/**
 * The mapping file is the whole configuration of the sync, and every mistake in it is silent at
 * deploy time: a missing key writes an incomplete Secret, a duplicate key writes whichever value
 * came last. So the shipped file is checked here, not only the validator.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  validateMapping, loadMapping, tokenSecretName, namespacesFromEnv, groupBySecret
} = require('../../src/secret-sync/mapping');

test('the shipped mapping.json passes its own rules', () => {
  assert.deepStrictEqual(validateMapping(loadMapping()), []);
});

test('every shipped entry names a namespace, a key and a vault secret', () => {
  for (const entry of loadMapping()) {
    assert.ok(entry.namespace, `namespace missing on ${entry.vaultSecret}`);
    assert.ok(entry.key, `key missing on ${entry.vaultSecret}`);
    assert.ok(entry.vaultSecret, `vaultSecret missing on ${entry.namespace}/${entry.secretName}`);
    assert.ok(Array.isArray(entry.restart));
  }
});

test('no two shipped entries write the same key of the same Secret', () => {
  const seen = new Set();
  for (const entry of loadMapping()) {
    const id = `${entry.namespace}/${entry.secretName}/${entry.key}`;
    assert.ok(!seen.has(id), `duplicate ${id}`);
    seen.add(id);
  }
});

test('a dev entry is prefixed, because demi-kv-test serves both nonprod namespaces', () => {
  const dev = loadMapping().filter((e) => e.namespace === '6cdc9e-dev');
  assert.ok(dev.length > 0);
  for (const entry of dev) {
    assert.ok(entry.vaultSecret.startsWith('dev-'),
      `${entry.vaultSecret} would collide with the 6cdc9e-test entry of the same name`);
  }
});

test('the shipped mapping names no prod namespace, because prod runs no sync app', () => {
  const prod = loadMapping().filter((e) => e.namespace === '6cdc9e-prod');
  assert.deepStrictEqual(prod, [],
    'prod OpenShift secrets are set by hand: no sync app can reach the cluster from the prod spoke');
});

test('validation reports a missing key rather than accepting the entry', () => {
  const problems = validateMapping([
    { vaultSecret: 'a', namespace: '6cdc9e-test', secretName: 's', restart: [] }
  ]);
  assert.deepStrictEqual(problems, ['entry 0: key is required']);
});

test('validation reports a duplicate secretName+key', () => {
  const entry = {
    vaultSecret: 'a', namespace: '6cdc9e-test', secretName: 's', key: 'K', restart: []
  };
  const problems = validateMapping([entry, { ...entry, vaultSecret: 'b' }]);
  assert.deepStrictEqual(problems, ['entry 1: duplicate 6cdc9e-test/s/K']);
});

test('validation rejects a restart target that is neither a Deployment nor a CronJob', () => {
  const problems = validateMapping([{
    vaultSecret: 'a', namespace: '6cdc9e-test', secretName: 's', key: 'K',
    restart: [{ kind: 'StatefulSet', name: 'x' }]
  }]);
  assert.deepStrictEqual(problems, ['entry 0: restart[0].kind must be Deployment or CronJob']);
});

test('loadMapping throws rather than returning a mapping the reconcile cannot trust', (t) => {
  const file = require('node:path').join(
    require('node:os').tmpdir(), `bad-mapping-${process.pid}.json`
  );
  require('node:fs').writeFileSync(file, JSON.stringify([{ vaultSecret: 'a' }]));
  t.after(() => require('node:fs').unlinkSync(file));

  assert.throws(() => loadMapping(file), /namespace is required/);
});

test('the token secret name follows the vault the namespace is served by', () => {
  assert.strictEqual(tokenSecretName('6cdc9e-dev'), 'dev-openshift-token');
  assert.strictEqual(tokenSecretName('6cdc9e-test'), 'openshift-token-test');
  assert.strictEqual(tokenSecretName('6cdc9e-prod'), 'openshift-token-prod');
});

test('SYNC_NAMESPACES is a comma list, and empty means none', () => {
  assert.deepStrictEqual(namespacesFromEnv('6cdc9e-dev, 6cdc9e-test'), ['6cdc9e-dev', '6cdc9e-test']);
  assert.deepStrictEqual(namespacesFromEnv(''), []);
  assert.deepStrictEqual(namespacesFromEnv(undefined), []);
});

test('grouping keeps one OpenShift Secret per name and only the asked-for namespace', () => {
  const groups = groupBySecret(loadMapping(), '6cdc9e-test');
  assert.strictEqual(groups.get('eagle-api-mongodb').length, 4,
    'the test namespace has four mongo keys — dev has a fifth, MONGODB_USERNAME');
  assert.strictEqual(groups.get('rproxy-basic-auth').length, 4);
  for (const entries of groups.values()) {
    for (const entry of entries) assert.strictEqual(entry.namespace, '6cdc9e-test');
  }
});
