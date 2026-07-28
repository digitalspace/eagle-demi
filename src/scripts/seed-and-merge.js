'use strict';

const fs = require('fs');
const { initCosmosClient } = require('../db/cosmos');
const Project = require('../models/project');
const Document = require('../models/document');

async function run() {
  console.log('[Seed & Merge] Initializing Cosmos DB SDK client...');
  await initCosmosClient();

  try {
    // 1. Load Track enriched metadata
    const jsonPath = '/root/repos/track_projects_enriched.json';
    console.log(`[Seed & Merge] Reading Track projects from: ${jsonPath}`);
    if (!fs.existsSync(jsonPath)) {
      throw new Error(`Enriched JSON file not found at ${jsonPath}`);
    }
    const rawData = fs.readFileSync(jsonPath, 'utf8');
    const trackProjects = JSON.parse(rawData);
    console.log(`[Seed & Merge] Loaded ${trackProjects.length} projects from Track JSON.`);

    let trackMergedCount = 0;
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
        region: tp.region_name || 'Unknown Region',
        description: tp.description || '',
        proponentName: tp.proponent_name || '',
        projectState: tp.project_state_name || '',
        projectType: tp.type_name || '',
        projectSubType: tp.sub_type_name || '',
        centroid: {
          type: 'Point',
          coordinates: coords
        },
        metadata: {
          description: tp.description || '',
          address: tp.address || '',
          abbreviation: tp.abbreviation || '',
          proponent_name: tp.proponent_name || '',
          sub_type_name: tp.sub_type_name || '',
          type_name: tp.type_name || '',
          project_state_name: tp.project_state_name || '',
          is_active_in_track: tp.is_active,
          trackAttributes: tp
        },
        isPublished: true,
        sources: {
          track: tp,
          eagle: null,
          nrpti: { recordCount: 0, orderCount: 0, inspectionCount: 0, ticketCount: 0, lastRecordDate: null }
        }
      };

      await Project.upsert(projDoc);
      trackMergedCount++;
    }

    console.log('\n[Seed & Merge] Complete!');
    console.log('=================================');
    console.log(`- Projects Seeded into Cosmos DB: ${trackMergedCount}`);
    console.log('=================================');

  } catch (err) {
    console.error('[Seed & Merge] Fatal error:', err);
  }
}

if (require.main === module) {
  run().then(() => process.exit(0));
}

module.exports = { run };
