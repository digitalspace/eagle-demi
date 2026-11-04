'use strict';

// Azure Monitor must start before winston is required: the distro instruments modules by hooking require.
if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
  const { useAzureMonitor } = require('@azure/monitor-opentelemetry');
  useAzureMonitor({
    enablePerformanceCounters: false,
    instrumentationOptions: { winston: { enabled: true } }
  });
}

const { app } = require('@azure/functions');
const { SecretClient } = require('@azure/keyvault-secrets');

const { logger } = require('../secret-sync/logger');
const { createCredential, azureRequest, ARM_SCOPE } = require('../utils/azure-credential');
const { createProbe } = require('./probe');
const { run } = require('./rotate');

const notFound = (err) => err.statusCode === 404 || err.code === 'SecretNotFound';

const properties = (p) => ({
  name: p.name,
  version: p.version,
  enabled: p.enabled !== false,
  expiresOn: p.expiresOn || null,
  contentType: p.contentType || null,
  tags: p.tags || {}
});

/** The vault surface rotate.js uses. No delete method, on purpose. */
function createVault(client) {
  return {
    async get(name) {
      try {
        const secret = await client.getSecret(name);
        return { ...properties(secret.properties), value: secret.value };
      } catch (err) {
        if (notFound(err)) return null;
        throw err;
      }
    },
    /** Value of the version created just before the latest one, or null. */
    async previous(name) {
      const versions = [];
      for await (const p of client.listPropertiesOfSecretVersions(name)) versions.push(p);
      versions.sort((a, b) => b.createdOn - a.createdOn);
      if (versions.length < 2) return null;
      return (await client.getSecret(name, { version: versions[1].version })).value;
    },
    async set(name, value, { expiresOn, contentType, tags }) {
      const secret = await client.setSecret(name, value, { expiresOn, contentType, tags });
      return secret.properties.version;
    },
    async tag(name, version, tags) {
      await client.updateSecretProperties(name, version, { tags });
    },
    async list() {
      const out = [];
      for await (const p of client.listPropertiesOfSecrets()) out.push(properties(p));
      return out;
    }
  };
}

async function secretRotatorHourly() {
  const vaultUri = process.env.KEY_VAULT_URI;
  if (!vaultUri) {
    logger.error('[secret-rotator] FAILED KEY_VAULT_URI is not set');
    return;
  }
  const credential = createCredential();
  await run({
    vault: createVault(new SecretClient(vaultUri, credential)),
    arm: (method, url, body) => azureRequest(credential, ARM_SCOPE, method, url, body),
    probe: createProbe({ demiUrl: process.env.PROBE_DEMI_URL, analyticsUrl: process.env.PROBE_ANALYTICS_URL }),
    log: logger
  });
}

module.exports = { secretRotatorHourly, createVault };

app.timer('secretRotatorHourly', {
  schedule: '0 0 * * * *',
  // Deploys restart the app; a restart is not a reason to move a rotation on early.
  runOnStartup: false,
  handler: () => secretRotatorHourly()
});
