'use strict';

/**
 * The bit of the Kubernetes API this sync needs, over `fetch`.
 *
 * No `oc` binary and no client library: a Flex Consumption worker has no shell to run one in, and
 * the four calls below (get, create, replace, patch) are the whole surface. Node 22 has `fetch`.
 */

const SECRETS_PATH = (namespace) => `/api/v1/namespaces/${namespace}/secrets`;

const WORKLOAD_PATH = {
  Deployment: (namespace, name) => `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`,
  CronJob: (namespace, name) => `/apis/batch/v1/namespaces/${namespace}/cronjobs/${name}`
};

/**
 * Where a workload carries the annotation that makes its pods roll.
 *
 * The annotation goes on the POD TEMPLATE, not the workload: an annotation on the workload's own
 * metadata changes nothing about the pod spec, so the ReplicaSet stays as it is and no pod
 * restarts. A CronJob's template sits one level deeper, under its job template.
 */
function restartPatch(kind, timestamp) {
  const annotations = { 'secret-sync/restarted-at': timestamp };
  if (kind === 'CronJob') {
    return { spec: { jobTemplate: { spec: { template: { metadata: { annotations } } } } } };
  }
  return { spec: { template: { metadata: { annotations } } } };
}

/**
 * @param {object} options
 * @param {string} options.apiServer e.g. https://api.silver.devops.gov.bc.ca:6443
 * @param {string} options.token ServiceAccount token for ONE namespace
 * @param {Function} [options.fetchImpl] injected in tests
 */
function createClient({ apiServer, token, fetchImpl = fetch }) {
  const base = String(apiServer).replace(/\/$/, '');

  async function call(method, path, body, contentType = 'application/json') {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        // Never logged, never returned. The only place the token appears.
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': contentType })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      // The API server echoes the object it rejected; the message alone is enough to fix a bad
      // name or a missing permission, and the body could carry secret data.
      throw new Error(`${method} ${path} failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  return {
    /** The live Secret, or null when it does not exist yet. */
    getSecret: (namespace, name) => call('GET', `${SECRETS_PATH(namespace)}/${name}`),

    /** Whole-object write: PUT when it exists, POST when it does not. */
    async writeSecret(namespace, name, secret, exists) {
      return exists
        ? call('PUT', `${SECRETS_PATH(namespace)}/${name}`, secret)
        : call('POST', SECRETS_PATH(namespace), secret);
    },

    /** Stamp the pod template so the workload rolls. Returns false when the workload is gone. */
    async restartWorkload(namespace, kind, name, timestamp) {
      const path = WORKLOAD_PATH[kind];
      if (!path) throw new Error(`unsupported restart kind: ${kind}`);
      const result = await call(
        'PATCH', path(namespace, name), restartPatch(kind, timestamp),
        'application/merge-patch+json'
      );
      return result !== null;
    }
  };
}

module.exports = { createClient, restartPatch, WORKLOAD_PATH };
