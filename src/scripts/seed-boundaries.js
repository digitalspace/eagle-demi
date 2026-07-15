'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../config');
const Boundary = require('../models/boundary');

const LAYERS = [
  {
    type: 'Regional District',
    url: 'https://openmaps.gov.bc.ca/geo/pub/wfs?service=WFS&version=1.1.0&request=GetFeature&typeName=pub:WHSE_LEGAL_ADMIN_BOUNDARIES.ABMS_REGIONAL_DISTRICTS_SP&outputFormat=application/json&srsName=EPSG:4326',
    getName: (f) => f.properties.ADMIN_AREA_NAME || f.properties.REGIONAL_DISTRICT_NAME || f.properties.REG_DIST_NAME || '',
    getCode: (f) => f.properties.LGL_ADMIN_AREA_ID || f.properties.REGIONAL_DISTRICT_NUM || f.properties.REG_DIST_ID || ''
  },
  {
    type: 'Municipality',
    url: 'https://openmaps.gov.bc.ca/geo/pub/wfs?service=WFS&version=1.1.0&request=GetFeature&typeName=pub:WHSE_LEGAL_ADMIN_BOUNDARIES.ABMS_MUNICIPALITIES_SP&outputFormat=application/json&srsName=EPSG:4326',
    getName: (f) => f.properties.ADMIN_AREA_NAME || f.properties.MUNICIPALITY_NAME || f.properties.MUN_NAME || '',
    getCode: (f) => f.properties.LGL_ADMIN_AREA_ID || f.properties.MUNICIPALITY_ID || f.properties.MUN_ID || ''
  },
  {
    type: 'Electoral District',
    url: 'https://openmaps.gov.bc.ca/geo/pub/wfs?service=WFS&version=1.1.0&request=GetFeature&typeName=pub:WHSE_ADMIN_BOUNDARIES.EBC_PROV_ELECTORAL_DIST_SVW&outputFormat=application/json&srsName=EPSG:4326',
    getName: (f) => f.properties.ED_NAME || f.properties.ELECTORAL_DISTRICT_NAME || '',
    getCode: (f) => f.properties.ELECTORAL_DISTRICT_ID || f.properties.ED_CODE || ''
  }
];

async function run() {
  console.log('Connecting to database...');
  await mongoose.connect(config.mongoUri);
  console.log('Connected.');

  for (const layer of LAYERS) {
    console.log(`\nFetching ${layer.type} features from B.C. OpenMaps WFS API...`);
    try {
      const response = await fetch(layer.url);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      
      if (!data.features || data.features.length === 0) {
        console.warn(`No features found for ${layer.type}`);
        continue;
      }

      console.log(`Fetched ${data.features.length} features. Ingesting into database...`);

      const docs = data.features.map(f => {
        // Handle invalid geometries or nulls gracefully
        if (!f.geometry || !f.geometry.coordinates) return null;
        return {
          type: layer.type,
          name: layer.getName(f),
          code: String(layer.getCode(f)),
          geometry: f.geometry
        };
      }).filter(Boolean);

      console.log(`Clearing existing ${layer.type} records...`);
      await Boundary.deleteMany({ type: layer.type });

      console.log(`Inserting ${docs.length} valid records...`);
      await Boundary.insertMany(docs);
      console.log(`✓ successfully seeded ${docs.length} ${layer.type} records!`);

    } catch (err) {
      console.error(`Error processing ${layer.type}:`, err.message);
    }
  }

  console.log('\nRetroactively tagging existing projects with administrative boundaries...');
  try {
    const Project = require('../models/project');
    const projects = await Project.find({ 'centroid.coordinates': { $exists: true, $ne: [] } });
    console.log(`Found ${projects.length} projects with centroids to process.`);
    
    let updatedCount = 0;
    for (const project of projects) {
      const intersectingBoundaries = await Boundary.find({
        geometry: {
          $geoIntersects: {
            $geometry: {
              type: 'Point',
              coordinates: project.centroid.coordinates
            }
          }
        }
      });
      
      const regionalDistrict = intersectingBoundaries.find(b => b.type === 'Regional District')?.name || '';
      const municipality = intersectingBoundaries.find(b => b.type === 'Municipality')?.name || '';
      const electoralDistrict = intersectingBoundaries.find(b => b.type === 'Electoral District')?.name || '';
      
      let modified = false;
      if (project.regionalDistrict !== regionalDistrict) {
        project.regionalDistrict = regionalDistrict;
        modified = true;
      }
      if (project.municipality !== municipality) {
        project.municipality = municipality;
        modified = true;
      }
      if (project.electoralDistrict !== electoralDistrict) {
        project.electoralDistrict = electoralDistrict;
        modified = true;
      }
      
      if (modified) {
        await project.save();
        updatedCount++;
      }
    }
    console.log(`✓ Retroactively updated ${updatedCount} projects with spatial boundaries.`);
  } catch (err) {
    console.error('Error during retroactive project tagging:', err);
  }

  await mongoose.disconnect();
  console.log('\nFinished all boundary migrations.');
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
