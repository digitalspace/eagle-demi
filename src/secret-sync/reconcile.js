'use strict';

/**
 * Fail closed: a missing or empty vault secret, or a missing OpenShift Secret, keeps the last good
 * copy and fails the run so it shows in Application Insights.
 */

const { groupBySecret, tokenSecretName } = require('./mapping');

const VERSION_ANNOTATION = 'secret-sync/vault-version';
const UPDATED_ANNOTATION = 'secret-sync/updated-at';

/**
 * Only mapped keys count: unmapped keys and this sync's own annotations would show drift on every
 * run and roll every consumer.
 */
function secretDataChanged(live, desiredData) {
  if (!live || !live.data) return true;
  return Object.keys(desiredData).some((key) => live.data[key] !== desiredData[key]);
}

/**
 * The live object with mapped keys overwritten. PUT replaces the whole Secret, so anything not
 * carried over is deleted and workloads binding it fail to start.
 */
function buildSecret({ namespace, name, data, live, versions, timestamp }) {
  const annotations = { ...((live && live.metadata && live.metadata.annotations) || {}) };
  // One shape for one key and for six: `<vaultSecret>=<version>`, sorted. A bare version would be
  // ambiguous the moment a Secret has more than one key, and eagle-api-mongodb has five.
  annotations[VERSION_ANNOTATION] = Object.keys(versions).sort()
    .map((vaultSecret) => `${vaultSecret}=${versions[vaultSecret]}`)
    .join(',');
  annotations[UPDATED_ANNOTATION] = timestamp;

  return {
    ...(live || {}),
    apiVersion: (live && live.apiVersion) || 'v1',
    kind: (live && live.kind) || 'Secret',
    type: (live && live.type) || 'Opaque',
    metadata: {
      ...((live && live.metadata) || {}),
      name,
      namespace,
      annotations
    },
    data: { ...((live && live.data) || {}), ...data }
  };
}

/**
 * @param {object} options
 * @param {Array} options.entries mapping entries (all namespaces)
 * @param {string[]} options.namespaces the namespaces this app owns
 * @param {Function} options.readSecret async (vaultSecretName) => { value, version } | null
 * @param {Function} options.createClient ({ token }) => OpenShift client
 * @param {object} options.logger winston logger
 * @param {Function} [options.now] clock, injected in tests
 * @returns {Promise<{checked:number, updated:number, restarted:number, missing:number, ok:boolean}>}
 */
async function reconcile({ entries, namespaces, readSecret, createClient, logger, now = () => new Date() }) {
  const counts = { checked: 0, updated: 0, restarted: 0, missing: 0 };
  const timestamp = now().toISOString();

  for (const namespace of namespaces) {
    const tokenName = tokenSecretName(namespace);
    const tokenSecret = await readSecret(tokenName);
    if (!tokenSecret || !tokenSecret.value) {
      counts.missing += 1;
      logger.error(`[secret-sync] no API token in the vault under '${tokenName}' — ${namespace} skipped`);
      continue;
    }

    const client = createClient({ token: tokenSecret.value });
    const groups = groupBySecret(entries, namespace);
    // One workload restarts once per run however many of its Secrets changed.
    const toRestart = new Map();

    for (const [secretName, groupEntries] of groups) {
      counts.checked += 1;

      const data = {};
      const versions = {};
      let complete = true;
      for (const entry of groupEntries) {
        const secret = await readSecret(entry.vaultSecret);
        if (!secret || !secret.value) {
          complete = false;
          counts.missing += 1;
          logger.error(
            `[secret-sync] vault secret '${entry.vaultSecret}' is missing or empty — ` +
            `${namespace}/${secretName} left as it is`
          );
          continue;
        }
        data[entry.key] = Buffer.from(secret.value, 'utf8').toString('base64');
        versions[entry.vaultSecret] = secret.version;
      }
      // Partial writes are the failure this guard exists for: writing four of five rotated keys
      // leaves the live Secret half old and half new, and restarts its consumers onto that.
      if (!complete) continue;

      const live = await client.getSecret(namespace, secretName);
      if (!live) {
        counts.missing += 1;
        logger.error(
          `[secret-sync] no Secret '${secretName}' in ${namespace} — ` +
          'create it once by hand, then this run writes its values'
        );
        continue;
      }
      if (!secretDataChanged(live, data)) continue;

      await client.replaceSecret(
        namespace, secretName,
        buildSecret({ namespace, name: secretName, data, live, versions, timestamp })
      );
      counts.updated += 1;
      logger.info(`[secret-sync] wrote ${namespace}/${secretName} (${Object.keys(data).length} keys)`);

      for (const target of groupEntries[0].restart || []) {
        toRestart.set(`${target.kind}/${target.name}`, target);
      }
    }

    for (const target of toRestart.values()) {
      const patched = await client.restartWorkload(namespace, target.kind, target.name, timestamp);
      if (patched) {
        counts.restarted += 1;
      } else {
        // Not fatal: the Secret is written and correct, the workload just is not there. A mapping
        // that names a workload the namespace does not have is worth seeing, not worth failing on.
        logger.warn(`[secret-sync] ${namespace} has no ${target.kind}/${target.name} to restart`);
      }
    }
  }

  const ok = counts.missing === 0;
  logger.info(
    `[secret-sync] run finished: checked=${counts.checked} updated=${counts.updated} ` +
    `restarted=${counts.restarted} missing=${counts.missing}`
  );
  return { ...counts, ok };
}

module.exports = {
  reconcile,
  secretDataChanged
};
