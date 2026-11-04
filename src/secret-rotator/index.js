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
const { run, createVault } = require('./rotate');

async function secretRotatorHourly() {
  const vaultUri = process.env.KEY_VAULT_URI;
  const credential = createCredential();
  await run({
    vault: vaultUri ? createVault(new SecretClient(vaultUri, credential)) : null,
    arm: (method, url, body) => azureRequest(credential, ARM_SCOPE, method, url, body),
    probe: createProbe({ demiUrl: process.env.PROBE_DEMI_URL, analyticsUrl: process.env.PROBE_ANALYTICS_URL }),
    log: logger
  });
}

module.exports = { secretRotatorHourly };

app.timer('secretRotatorHourly', {
  schedule: '0 0 * * * *',
  runOnStartup: false,
  handler: () => secretRotatorHourly()
});
