'use strict';

const fs = require('fs');
const { initCosmosClient } = require('../db/cosmos');
const Project = require('../models/project');
const Document = require('../models/document');
// No search sync step any more. Typesense had to be PUSHED a copy of everything nightly; the AI
// Search indexers PULL from Cosmos on a five-minute high-water mark, so the index follows the
// database without a job. What remains here is the upstream data the registry itself needs.
const { syncNrptiData } = require('./sync-nrpti');
const { syncWildfiresData } = require('./sync-wildfires');

async function runNightlySync() {
  const startTime = Date.now();
  console.log('[Nightly Sync] Starting DEMI automated nightly sync job...');

  try {
    await initCosmosClient();

    // 1. Load Track Projects
    const jsonPath = process.env.TRACK_PROJECTS_JSON_PATH || '/root/repos/track_projects_enriched.json';
    let trackProjects = [];
    if (fs.existsSync(jsonPath)) {
      console.log(`[Nightly Sync] Loading Track projects from: ${jsonPath}`);
      trackProjects = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    }

    let syncedProjects = 0;
    for (const tp of trackProjects) {
      const tpId = Number(tp.track_project_id);
      let coords = [-123.3656, 48.4284];
      if (tp.latitude && tp.longitude) {
        const lat = parseFloat(tp.latitude);
        const lng = parseFloat(tp.longitude);
        if (!isNaN(lat) && !isNaN(lng)) coords = [lng, lat];
      }

      const projDoc = {
        _id: String(tpId),
        id: String(tpId),
        trackProjectId: tpId,
        name: tp.name || 'Unnamed Track Project',
        region: tp.region_name || '',
        description: tp.description || '',
        proponentName: tp.proponent_name || '',
        projectState: tp.project_state_name || '',
        projectType: tp.type_name || '',
        projectSubType: tp.sub_type_name || '',
        centroid: { type: 'Point', coordinates: coords },
        isPublished: true,
        read: ['public', 'sysadmin', 'staff', 'demi-admin'],
        sources: {
          track: tp,
          eagle: null,
          nrpti: { recordCount: 0, orderCount: 0, inspectionCount: 0, ticketCount: 0, lastRecordDate: null }
        }
      };

      await Project.upsert(projDoc);
      syncedProjects++;
    }
    console.log(`[Nightly Sync] Upserted ${syncedProjects} Track projects.`);

    // 2. Ingest NRPTI Compliance & Enforcement Records
    console.log('[Nightly Sync] Starting NRPTI compliance data ingestion...');
    try {
      const nrptiResults = await syncNrptiData();
      console.log(`[Nightly Sync] NRPTI sync finished: ${nrptiResults.totalIngested} records.`);
    } catch (nrptiErr) {
      console.error('[Nightly Sync] NRPTI sync error:', nrptiErr.message);
    }

    // 3. Ingest B.C. Wildfire Service Open Data
    console.log('[Nightly Sync] Starting B.C. Wildfire open data ingestion & proximity calculation...');
    try {
      const wildfireResults = await syncWildfiresData();
      console.log(`[Nightly Sync] Wildfire sync finished: ${wildfireResults.syncedWildfires} wildfires synced, ${wildfireResults.updatedProjects} projects updated.`);
    } catch (wildfireErr) {
      console.error('[Nightly Sync] Wildfire sync error:', wildfireErr.message);
    }

    // Step 4 was a full search re-index. It is gone: the AI Search indexers run every five
    // minutes off a `_ts` high-water mark, so whatever the steps above wrote is picked up without
    // a nightly push. The one thing a pull cannot see is a DELETE — that is handled at the point
    // of deletion instead, in the project and document controllers.

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[Nightly Sync] DEMI Nightly Sync Job completed in ${elapsed}s.`);
  } catch (err) {
    console.error('[Nightly Sync] Fatal error during DEMI nightly sync:', err);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  runNightlySync();
}

module.exports = { runNightlySync };
