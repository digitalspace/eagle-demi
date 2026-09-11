'use strict';

/**
 * The reconcile, against a fake Kubernetes API and a fake vault.
 *
 * The OpenShift client is the REAL one (src/secret-sync/openshift.js) with `fetch` injected, so
 * the request method, path and body shape are asserted as they would go on the wire — a patch that
 * annotates the wrong level restarts nothing, and that is invisible in a mocked client.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { reconcile, secretDataChanged } = require('../../src/secret-sync/reconcile');
const { createClient } = require('../../src/secret-sync/openshift');

const NAMESPACE = '6cdc9e-test';
const API = 'https://api.silver.devops.gov.bc.ca:6443';

const ENTRIES = [
  {
    vaultSecret: 'getok-secret-clientid', namespace: NAMESPACE, secretName: 'getok-secret',
    key: 'CLIENTID',
    restart: [{ kind: 'Deployment', name: 'eagle-api' }, { kind: 'CronJob', name: 'eagle-cron-hot' }]
  },
  {
    vaultSecret: 'getok-secret-client-secret', namespace: NAMESPACE, secretName: 'getok-secret',
    key: 'CLIENT_SECRET',
    restart: [{ kind: 'Deployment', name: 'eagle-api' }, { kind: 'CronJob', name: 'eagle-cron-hot' }]
  }
];

const b64 = (value) => Buffer.from(value, 'utf8').toString('base64');

/** Records every call and answers from `secrets`. Nothing here is a real credential. */
function fakeCluster({ secrets = {}, missingWorkloads = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const path = url.replace(API, '');
    calls.push({ method: options.method, path, body: options.body && JSON.parse(options.body) });

    if (options.method === 'GET') {
      const name = path.split('/').pop();
      return secrets[name]
        ? { ok: true, status: 200, json: async () => secrets[name] }
        : { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
    }
    if (options.method === 'PATCH' && missingWorkloads.some((n) => path.endsWith(`/${n}`))) {
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return { calls, fetchImpl };
}

const silentLogger = () => {
  const lines = { info: [], warn: [], error: [], debug: [] };
  return {
    lines,
    info: (m) => lines.info.push(m),
    warn: (m) => lines.warn.push(m),
    error: (m) => lines.error.push(m),
    debug: (m) => lines.debug.push(m)
  };
};

const vaultWith = (values) => async (name) =>
  (name in values ? { value: values[name], version: `v-${name}` } : null);

const VALUES = {
  'openshift-token-test': 'token-placeholder',
  'getok-secret-clientid': 'client-id-value',
  'getok-secret-client-secret': 'client-secret-value'
};

const run = ({ vault = vaultWith(VALUES), cluster = fakeCluster(), logger = silentLogger() } = {}) =>
  reconcile({
    entries: ENTRIES,
    namespaces: [NAMESPACE],
    readSecret: vault,
    createClient: ({ token }) => createClient({ apiServer: API, token, fetchImpl: cluster.fetchImpl }),
    logger,
    now: () => new Date('2026-09-10T06:00:00.000Z')
  }).then((result) => ({ result, cluster, logger }));

test('a secret that already matches the vault is not written and nothing restarts', async () => {
  const cluster = fakeCluster({
    secrets: {
      'getok-secret': {
        metadata: { name: 'getok-secret', annotations: { 'meta.helm.sh/release-name': 'eagle-api' } },
        data: { CLIENTID: b64('client-id-value'), CLIENT_SECRET: b64('client-secret-value') }
      }
    }
  });

  const { result } = await run({ cluster });

  assert.deepStrictEqual(
    cluster.calls.map((c) => c.method), ['GET'],
    'an unchanged secret must cost one GET — a PUT here would roll every consumer daily'
  );
  assert.deepStrictEqual(result, { checked: 1, updated: 0, restarted: 0, missing: 0, ok: true });
});

test('a changed value is written whole, stamped, and its consumers are patched', async () => {
  const cluster = fakeCluster({
    secrets: {
      'getok-secret': {
        type: 'Opaque',
        metadata: {
          name: 'getok-secret',
          labels: { app: 'eagle-api' },
          annotations: { 'meta.helm.sh/release-name': 'eagle-api' }
        },
        data: { CLIENTID: b64('client-id-value'), CLIENT_SECRET: b64('stale') }
      }
    }
  });

  const { result } = await run({ cluster });

  const put = cluster.calls.find((c) => c.method === 'PUT');
  assert.strictEqual(put.path, `/api/v1/namespaces/${NAMESPACE}/secrets/getok-secret`);
  assert.deepStrictEqual(put.body.data, {
    CLIENTID: b64('client-id-value'),
    CLIENT_SECRET: b64('client-secret-value')
  });
  assert.strictEqual(
    put.body.metadata.annotations['secret-sync/vault-version'],
    'getok-secret-client-secret=v-getok-secret-client-secret,getok-secret-clientid=v-getok-secret-clientid'
  );
  assert.strictEqual(put.body.metadata.annotations['secret-sync/updated-at'], '2026-09-10T06:00:00.000Z');
  assert.strictEqual(put.body.metadata.annotations['meta.helm.sh/release-name'], 'eagle-api',
    'a whole-object PUT that drops the Helm annotations orphans the release');
  assert.deepStrictEqual(put.body.metadata.labels, { app: 'eagle-api' });

  const patches = cluster.calls.filter((c) => c.method === 'PATCH');
  assert.deepStrictEqual(patches.map((p) => p.path), [
    `/apis/apps/v1/namespaces/${NAMESPACE}/deployments/eagle-api`,
    `/apis/batch/v1/namespaces/${NAMESPACE}/cronjobs/eagle-cron-hot`
  ]);
  assert.deepStrictEqual(patches[0].body, {
    spec: { template: { metadata: { annotations: { 'secret-sync/restarted-at': '2026-09-10T06:00:00.000Z' } } } }
  });
  assert.deepStrictEqual(patches[1].body, {
    spec: {
      jobTemplate: {
        spec: { template: { metadata: { annotations: { 'secret-sync/restarted-at': '2026-09-10T06:00:00.000Z' } } } }
      }
    }
  }, 'a CronJob annotated anywhere but its job template runs the old value at the next schedule');

  assert.deepStrictEqual(result, { checked: 1, updated: 1, restarted: 2, missing: 0, ok: true });
});

test('a Secret that does not exist yet is created rather than replaced', async () => {
  const { result, cluster } = await run();

  const post = cluster.calls.find((c) => c.method === 'POST');
  assert.strictEqual(post.path, `/api/v1/namespaces/${NAMESPACE}/secrets`);
  assert.strictEqual(post.body.metadata.name, 'getok-secret');
  assert.strictEqual(result.updated, 1);
});

test('one missing vault secret writes nothing for that Secret and fails the run', async () => {
  const { 'getok-secret-client-secret': _dropped, ...partial } = VALUES;
  const cluster = fakeCluster();

  const { result, logger } = await run({ vault: vaultWith(partial), cluster });

  assert.deepStrictEqual(
    cluster.calls.map((c) => c.method), [],
    'a partial write would DELETE the key the vault is missing from a live secret'
  );
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.missing, 1);
  assert.strictEqual(result.updated, 0);
  assert.match(logger.lines.error[0], /getok-secret-client-secret/);
});

test('an empty value counts as missing', async () => {
  const cluster = fakeCluster();
  const { result } = await run({
    vault: vaultWith({ ...VALUES, 'getok-secret-clientid': '' }), cluster
  });

  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(cluster.calls.map((c) => c.method), []);
});

test('no token for a namespace skips it whole and fails the run', async () => {
  const { 'openshift-token-test': _dropped, ...noToken } = VALUES;
  const cluster = fakeCluster();

  const { result, logger } = await run({ vault: vaultWith(noToken), cluster });

  assert.deepStrictEqual(cluster.calls, []);
  assert.deepStrictEqual(result, { checked: 0, updated: 0, restarted: 0, missing: 1, ok: false });
  assert.match(logger.lines.error[0], /openshift-token-test/);
});

test('a restart target the namespace does not have warns, and the run still succeeds', async () => {
  const cluster = fakeCluster({ missingWorkloads: ['eagle-cron-hot'] });

  const { result, logger } = await run({ cluster });

  assert.strictEqual(result.restarted, 1);
  assert.strictEqual(result.ok, true, 'the secret is written and correct; the workload is simply gone');
  assert.match(logger.lines.warn[0], /CronJob\/eagle-cron-hot/);
});

test('the run reports its counts once', async () => {
  const { logger } = await run();
  const summary = logger.lines.info.filter((line) => line.includes('run finished'));
  assert.strictEqual(summary.length, 1);
  assert.match(summary[0], /checked=1 updated=1 restarted=2 missing=0/);
});

test('the diff ignores annotations and sees a key added, removed or changed', () => {
  const data = { A: b64('1'), B: b64('2') };
  assert.strictEqual(secretDataChanged({ data: { ...data } }, data), false);
  assert.strictEqual(secretDataChanged({ data: { A: b64('1') } }, data), true, 'key added');
  assert.strictEqual(secretDataChanged({ data: { ...data, C: b64('3') } }, data), true, 'key removed');
  assert.strictEqual(secretDataChanged({ data: { ...data, B: b64('x') } }, data), true, 'value changed');
  assert.strictEqual(secretDataChanged(null, data), true, 'no live secret at all');
  assert.strictEqual(
    secretDataChanged({ metadata: { annotations: { 'secret-sync/updated-at': 'then' } }, data }, data),
    false,
    'the stamp this sync writes must not be what makes the next run write again'
  );
});
