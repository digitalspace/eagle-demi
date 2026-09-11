'use strict';

/**
 * One reconcile pass: Key Vault is the truth, the OpenShift Secret is the copy.
 *
 * Both triggers (Event Grid on a new secret version, and the daily timer) call this. It is
 * idempotent by design — a run that finds nothing changed writes nothing and restarts nothing, so
 * the daily pass costs one GET per mapped Secret and never rolls a pod on its own.
 *
 * FAIL CLOSED: a mapped vault secret that is missing or empty stops its own Secret from being
 * written, leaving the last good copy in place, and makes the whole run fail so the failure is
 * visible in Application Insights rather than silently skipped. A mapped OpenShift Secret that is
 * not in the namespace counts the same way: this app can replace a Secret, never make one, so the
 * object has to exist before the mapping entry does.
 */

const { groupBySecret, tokenSecretName } = require('./mapping');

const VERSION_ANNOTATION = 'secret-sync/vault-version';
const UPDATED_ANNOTATION = 'secret-sync/updated-at';
const RESTARTED_ANNOTATION = 'secret-sync/restarted-at';

/**
 * Does the live Secret already hold exactly this data?
 *
 * Only `data` is compared. The annotations this sync stamps are deliberately excluded: comparing
 * them would make every run differ from itself (the timestamp) and turn drift detection into an
 * unconditional write.
 */
function secretDataChanged(live, desiredData) {
  if (!live || !live.data) return true;
  const liveKeys = Object.keys(live.data).sort();
  const desiredKeys = Object.keys(desiredData).sort();
  if (liveKeys.length !== desiredKeys.length) return true;
  if (liveKeys.some((key, i) => key !== desiredKeys[i])) return true;
  return desiredKeys.some((key) => live.data[key] !== desiredData[key]);
}

/**
 * The object to write. Labels and any annotation this sync does not own are carried over from the
 * live object, because a PUT replaces the whole thing and the Helm release metadata lives there.
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
    apiVersion: 'v1',
    kind: 'Secret',
    type: (live && live.type) || 'Opaque',
    metadata: {
      name,
      namespace,
      labels: (live && live.metadata && live.metadata.labels) || undefined,
      annotations
    },
    data
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
      // Partial writes are the failure this guard exists for: an OpenShift Secret is replaced
      // whole, so writing four of five keys DELETES the fifth from a live app.
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
  secretDataChanged,
  buildSecret,
  VERSION_ANNOTATION,
  UPDATED_ANNOTATION,
  RESTARTED_ANNOTATION
};
