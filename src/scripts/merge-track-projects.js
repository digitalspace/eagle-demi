'use strict';

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const config = require('../config');
const Project = require('../models/project');

async function run() {
  // Use direct connection if localhost is specified to prevent replica set resolution errors
  let mongoUri = config.mongoUri;
  if (mongoUri.includes('localhost') && !mongoUri.includes('directConnection')) {
    mongoUri = mongoUri.includes('?') 
      ? `${mongoUri}&directConnection=true` 
      : `${mongoUri}?directConnection=true`;
  }

  console.log(`Connecting to Central DEMI MongoDB at: ${mongoUri}`);
  try {
    await mongoose.connect(mongoUri);
    console.log('Successfully connected to MongoDB.');

    const jsonPath = '/root/repos/track_projects_enriched.json';
    console.log(`Reading Track projects from: ${jsonPath}`);
    if (!fs.existsSync(jsonPath)) {
      throw new Error(`Enriched JSON file not found at ${jsonPath}`);
    }
    const rawData = fs.readFileSync(jsonPath, 'utf8');
    const trackProjects = JSON.parse(rawData);
    console.log(`Loaded ${trackProjects.length} projects from Track.`);

    let matchedCount = 0;
    let updatedCount = 0;

    for (const trackProj of trackProjects) {
      const epicGuid = trackProj.epic_guid;
      const trackId = Number(trackProj.track_project_id);

      let query = {};
      if (epicGuid && mongoose.Types.ObjectId.isValid(epicGuid)) {
        query = { _id: new mongoose.Types.ObjectId(epicGuid) };
      } else if (trackId) {
        query = { trackProjectId: trackId };
      } else {
        continue;
      }

      // Find existing project inside DEMI projects collection
      const project = await Project.findOne(query);
      if (project) {
        matchedCount++;

        // Prepare metadata block
        const metadata = {
          description: trackProj.description || '',
          address: trackProj.address || '',
          abbreviation: trackProj.abbreviation || '',
          proponent_name: trackProj.proponent_name || '',
          sub_type_name: trackProj.sub_type_name || '',
          type_name: trackProj.type_name || '',
          project_state_name: trackProj.project_state_name || '',
          is_active_in_track: trackProj.is_active
        };

        // Align trackProjectId and metadata fields
        project.trackProjectId = trackId;
        project.metadata = metadata;

        // Convert coordinates from Track (lat, lng) to MongoDB standard GeoJSON (lng, lat)
        if (trackProj.latitude && trackProj.longitude) {
          const lat = parseFloat(trackProj.latitude);
          const lng = parseFloat(trackProj.longitude);
          if (!isNaN(lat) && !isNaN(lng)) {
            project.centroid = {
              type: 'Point',
              coordinates: [lng, lat] // [longitude, latitude]
            };
          }
        }

        await project.save();
        console.log(`Merged Track metadata for Project: "${project.name}" (ID: ${trackId})`);
        updatedCount++;
      }
    }

    console.log(`\nMerge summary:`);
    console.log(`- Matched Projects: ${matchedCount}`);
    console.log(`- Updated Projects: ${updatedCount}`);

  } catch (err) {
    console.error('Error during merge:', err);
  } finally {
    await mongoose.connection.close();
    console.log('Database connection closed.');
  }
}

run();
