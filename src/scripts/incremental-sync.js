'use strict';

/**
 * Incremental Delta Sync Runner for DEMI
 *
 * Persists and checks high-water marks in Cosmos DB (`sync_state` container).
 * Fetches only updated records since the last successful sync timestamp (`since`).
 */

const { initCosmosClient } = require('../db/cosmos');
const SyncState = require('../models/syncState');
const { runSync: runOpenShiftSync } = require('./sync_from_openshift');
const { syncNrptiData } = require('./sync-nrpti');
const { syncWildfiresData } = require('./sync-wildfires');
const { fullSync: triggerTypesenseSync } = require('../typesense/full-sync');

async function runIncrementalSync() {
  const syncStartTime = new Date().toISOString();
  console.log(`[Incremental Sync] Starting delta sync at ${syncStartTime}...`);

  await initCosmosClient();

  // 1. OpenShift Sync
  const openshiftState = await SyncState.getState('openshift');
  const openshiftSince = openshiftState?.lastSyncedAt || '1970-01-01T00:00:00.000Z';
  console.log(`[Incremental Sync] Syncing OpenShift data modified since ${openshiftSince}...`);
  try {
    await runOpenShiftSync({ since: openshiftSince });
    await SyncState.setHighWaterMark('openshift', syncStartTime, { status: 'success' });
  } catch (err) {
    console.error('[Incremental Sync] OpenShift sync failed:', err.message);
  }

  // 2. NRPTI Sync
  const nrptiState = await SyncState.getState('nrpti');
  const nrptiSince = nrptiState?.lastSyncedAt || '1970-01-01T00:00:00.000Z';
  console.log(`[Incremental Sync] Syncing NRPTI compliance data modified since ${nrptiSince}...`);
  try {
    const nrptiRes = await syncNrptiData({ since: nrptiSince });
    await SyncState.setHighWaterMark('nrpti', syncStartTime, { status: 'success', ...nrptiRes });
  } catch (err) {
    console.error('[Incremental Sync] NRPTI sync failed:', err.message);
  }

  // 3. Wildfire Service Sync
  const wildfireState = await SyncState.getState('wildfire');
  const wildfireSince = wildfireState?.lastSyncedAt || '1970-01-01T00:00:00.000Z';
  console.log(`[Incremental Sync] Syncing Wildfire open data modified since ${wildfireSince}...`);
  try {
    const wildfireRes = await syncWildfiresData({ since: wildfireSince });
    await SyncState.setHighWaterMark('wildfire', syncStartTime, { status: 'success', ...wildfireRes });
  } catch (err) {
    console.error('[Incremental Sync] Wildfire sync failed:', err.message);
  }

  // 4. Trigger Typesense Re-Index
  console.log('[Incremental Sync] Triggering Typesense search re-indexing...');
  try {
    await triggerTypesenseSync();
    console.log('[Incremental Sync] Typesense search re-indexing complete.');
  } catch (err) {
    console.error('[Incremental Sync] Typesense re-indexing failed:', err.message);
  }

  console.log(`[Incremental Sync] Delta sync completed successfully at ${new Date().toISOString()}.`);
}

if (require.main === module) {
  runIncrementalSync()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[Incremental Sync] Fatal error:', err.message);
      process.exit(1);
    });
}

module.exports = { runIncrementalSync };
