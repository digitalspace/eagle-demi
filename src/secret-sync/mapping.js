'use strict';

/**
 * The mapping file, loaded and checked.
 *
 * mapping.json NEVER holds a value — only the vault secret name, where the copy goes, and which
 * workloads read it. One entry per KEY, because an OpenShift Secret with five keys is five vault
 * secrets: rotating one of them must not require re-writing the other four.
 */

const path = require('path');

/** Namespace suffix is the environment: `6cdc9e-test` -> `test`. */
function environmentOf(namespace) {
  return String(namespace).replace(/^6cdc9e-/, '');
}

/**
 * Which vault secret holds the API token for a namespace.
 *
 * `demi-kv-test` is the nonprod vault and serves both nonprod namespaces, so the dev entries carry
 * a `dev-` prefix the way every other dev name in mapping.json does.
 */
function tokenSecretName(namespace) {
  const env = environmentOf(namespace);
  return env === 'dev' ? 'dev-openshift-token' : `openshift-token-${env}`;
}

/**
 * Every problem with the mapping, not just the first: a half-checked mapping deployed is a sync
 * that writes some namespaces and throws on the rest.
 *
 * @param {Array} entries
 * @returns {string[]} messages, empty when the mapping is usable
 */
function validateMapping(entries) {
  const problems = [];
  if (!Array.isArray(entries)) return ['mapping must be an array'];

  const seen = new Set();
  entries.forEach((entry, i) => {
    const at = `entry ${i}`;
    for (const field of ['vaultSecret', 'namespace', 'secretName', 'key']) {
      if (!entry || typeof entry[field] !== 'string' || entry[field] === '') {
        problems.push(`${at}: ${field} is required`);
      }
    }
    if (!entry || !Array.isArray(entry.restart)) {
      problems.push(`${at}: restart must be an array (empty means nothing consumes it)`);
    } else {
      entry.restart.forEach((target, j) => {
        if (!target || (target.kind !== 'Deployment' && target.kind !== 'CronJob')) {
          problems.push(`${at}: restart[${j}].kind must be Deployment or CronJob`);
        }
        if (!target || typeof target.name !== 'string' || target.name === '') {
          problems.push(`${at}: restart[${j}].name is required`);
        }
      });
    }
    if (!entry || typeof entry.namespace !== 'string' || typeof entry.secretName !== 'string' ||
        typeof entry.key !== 'string') {
      return;
    }
    // Two entries writing the same key of the same Secret is one of them silently losing: the
    // whole `data` map is built in one pass and the later value wins by ordering alone.
    const id = `${entry.namespace}/${entry.secretName}/${entry.key}`;
    if (seen.has(id)) problems.push(`${at}: duplicate ${id}`);
    seen.add(id);
  });

  return problems;
}

/** The mapping as shipped. Throws rather than returning a mapping the reconcile cannot trust. */
function loadMapping(file = path.join(__dirname, 'mapping.json')) {
  const entries = require(file);
  const problems = validateMapping(entries);
  if (problems.length) {
    throw new Error(`${path.basename(file)} is not usable:\n  ${problems.join('\n  ')}`);
  }
  return entries;
}

/**
 * The namespaces this app syncs, from SYNC_NAMESPACES. One app per environment, so the setting is
 * what keeps the nonprod app off prod even though mapping.json describes all three.
 */
function namespacesFromEnv(raw = process.env.SYNC_NAMESPACES) {
  return String(raw || '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
}

/** Entries for one namespace, grouped into the OpenShift Secret objects they build. */
function groupBySecret(entries, namespace) {
  const groups = new Map();
  for (const entry of entries) {
    if (entry.namespace !== namespace) continue;
    if (!groups.has(entry.secretName)) groups.set(entry.secretName, []);
    groups.get(entry.secretName).push(entry);
  }
  return groups;
}

module.exports = {
  environmentOf,
  tokenSecretName,
  validateMapping,
  loadMapping,
  namespacesFromEnv,
  groupBySecret
};
