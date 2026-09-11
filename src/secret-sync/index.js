'use strict';

// Entry point of the `demi-secret-sync-<env>` Function app. Separate app, separate package: it
// deploys on its own and must not carry the API's routes, timers or queue workers.
//
// Azure Monitor has to start before anything else is required — the distro instruments modules by
// hooking `require`, so winston loaded first would report nothing. Same guard and same reason as
// api/index.js; the two cannot share a module because each app's entry file is the only place that
// runs before its own requires.
if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
  const { useAzureMonitor } = require('@azure/monitor-opentelemetry');
  useAzureMonitor({
    enablePerformanceCounters: false,
    instrumentationOptions: { winston: { enabled: true } }
  });
}

const { app } = require('@azure/functions');

const { logger } = require('./logger');
const { loadMapping, namespacesFromEnv } = require('./mapping');
const { reconcile } = require('./reconcile');
const { createVaultReader } = require('./vault');
const { createClient } = require('./openshift');

const OPENSHIFT_API = process.env.OPENSHIFT_API || 'https://api.silver.devops.gov.bc.ca:6443';

// The one event type this app acts on. A vault also emits SecretNearExpiry, SecretExpired and the
// certificate and key equivalents, and none of them mean the VALUE changed.
const NEW_VERSION_EVENT = 'Microsoft.KeyVault.SecretNewVersionCreated';

// Exported so both triggers are callable outside the host; the host is the only other caller.
module.exports = { runSync, onVaultEvent };

async function runSync(reason) {
  const entries = loadMapping();
  const namespaces = namespacesFromEnv();
  if (namespaces.length === 0) {
    logger.warn('[secret-sync] SYNC_NAMESPACES is empty — nothing to sync');
    return;
  }

  logger.info(`[secret-sync] run started (${reason}) for ${namespaces.join(', ')}`);
  const readSecret = createVaultReader();
  const result = await reconcile({
    entries,
    namespaces,
    readSecret,
    createClient: ({ token }) => createClient({ apiServer: OPENSHIFT_API, token }),
    logger
  });

  // The run fails when a mapped secret was missing. Nothing was written for it, and a failed
  // invocation is what makes that visible — a warning in a log nobody reads is not an alert.
  if (!result.ok) {
    throw new Error(`[secret-sync] ${result.missing} mapped vault secret(s) missing — see the errors above`);
  }
}

/**
 * A new version of a mapped secret. The subject of a Key Vault event is the secret name.
 *
 * An event for a name this repo does not map is ignored rather than failed: the vault also holds
 * the app settings the API resolves by reference, and those rotate on their own schedule.
 *
 * A mapped name reconciles EVERYTHING rather than just that secret. A run over unchanged secrets
 * is one GET each and no write, and doing the whole set means a version created while a run was in
 * flight is still picked up by the next event.
 */
async function onVaultEvent(event) {
  const name = (event && event.subject) || '';
  if (!event || event.eventType !== NEW_VERSION_EVENT) {
    logger.debug(`[secret-sync] ignoring '${event && event.eventType}' for '${name}'`);
    return;
  }
  const mapped = loadMapping().some((entry) => entry.vaultSecret === name);
  if (!mapped) {
    logger.debug(`[secret-sync] ignoring vault event for '${name}' — not in mapping.json`);
    return;
  }
  await runSync(`new version of ${name}`);
}

// Drift cover for anything the event stream missed: an event dropped, an app stopped for a day, or
// a secret changed in OpenShift by hand. 06:00 UTC is before the working day in BC.
app.timer('secretSyncDaily', {
  schedule: '0 0 6 * * *',
  // A restart is not a reason to rewrite every namespace, and deploys restart this app.
  runOnStartup: false,
  handler: () => runSync('daily timer')
});

// Filtering happens in the handler, not only in the subscription: the subscription's filter is
// infrastructure that can be edited in the portal, and an unfiltered event must still be a no-op.
app.eventGrid('secretSyncVaultEvent', {
  handler: (event) => onVaultEvent(event)
});
