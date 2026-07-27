const { logger } = require('../utils/logger');
const Boundary = require('../models/boundary');

const LAYERS = [
  {
    type: 'Regional District',
    url: 'https://openmaps.gov.bc.ca/geo/pub/wfs?service=WFS&version=1.1.0&request=GetFeature&typeName=pub:WHSE_LEGAL_ADMIN_BOUNDARIES.ABMS_REGIONAL_DISTRICTS_SP&outputFormat=application/json&srsName=EPSG:4326&maxFeatures=10000',
    getName: (f) => f.properties.ADMIN_AREA_NAME || f.properties.REGIONAL_DISTRICT_NAME || f.properties.REG_DIST_NAME || '',
    getCode: (f) => f.properties.LGL_ADMIN_AREA_ID || f.properties.REGIONAL_DISTRICT_NUM || f.properties.REG_DIST_ID || ''
  },
  {
    type: 'Municipality',
    url: 'https://openmaps.gov.bc.ca/geo/pub/wfs?service=WFS&version=1.1.0&request=GetFeature&typeName=pub:WHSE_LEGAL_ADMIN_BOUNDARIES.ABMS_MUNICIPALITIES_SP&outputFormat=application/json&srsName=EPSG:4326&maxFeatures=10000',
    getName: (f) => f.properties.ADMIN_AREA_NAME || f.properties.MUNICIPALITY_NAME || f.properties.MUN_NAME || '',
    getCode: (f) => f.properties.LGL_ADMIN_AREA_ID || f.properties.MUNICIPALITY_ID || f.properties.MUN_ID || ''
  },
  {
    type: 'Electoral District',
    url: 'https://openmaps.gov.bc.ca/geo/pub/wfs?service=WFS&version=1.1.0&request=GetFeature&typeName=pub:WHSE_ADMIN_BOUNDARIES.EBC_PROV_ELECTORAL_DIST_SVW&outputFormat=application/json&srsName=EPSG:4326&maxFeatures=10000',
    getName: (f) => f.properties.ED_NAME || f.properties.ELECTORAL_DISTRICT_NAME || '',
    getCode: (f) => f.properties.ELECTORAL_DISTRICT_ID || f.properties.ED_CODE || ''
  }
];

async function seedBoundaries() {
  const log = (msg) => (logger ? logger.info(msg) : console.log(msg));
  const logErr = (msg, err) => (logger ? logger.error(msg, { error: err?.message || err }) : console.error(msg, err));

  log('=== Starting B.C. OpenMaps WFS Boundary Seed ===');
  await Boundary.collection.dropIndex('type_1_name_1').catch(() => {});

  for (const layer of LAYERS) {
    log(`Fetching ${layer.type} features from B.C. OpenMaps WFS API...`);
    try {
      const response = await fetch(layer.url);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      
      if (!data.features || data.features.length === 0) {
        log(`No features found for ${layer.type}`);
        continue;
      }

      log(`Fetched ${data.features.length} features for ${layer.type}. Processing...`);

      const docs = data.features.map(f => {
        if (!f.geometry || !f.geometry.coordinates) return null;
        return {
          type: layer.type,
          name: layer.getName(f),
          code: String(layer.getCode(f)),
          geometry: f.geometry,
          simplifiedGeometry: simplifyGeometry(f.geometry, 0.001)
        };
      }).filter(Boolean);

      log(`Clearing existing ${layer.type} records...`);
      await Boundary.deleteMany({ type: layer.type });

      log(`Inserting ${docs.length} valid records for ${layer.type} in chunks...`);
      let insertedCount = 0;
      for (let i = 0; i < docs.length; i += 10) {
        const chunk = docs.slice(i, i + 10);
        try {
          await Boundary.insertMany(chunk, { ordered: false });
          insertedCount += chunk.length;
        } catch (bErr) {
          logErr(`Chunk insert warning for ${layer.type} at offset ${i}:`, bErr.message);
          // Fallback to individual inserts
          for (const doc of chunk) {
            try {
              await Boundary.updateOne(
                { type: doc.type, name: doc.name },
                { $set: doc },
                { upsert: true }
              );
              insertedCount++;
            } catch (iErr) {
              logErr(`Individual insert error for ${layer.type} ${doc.name}:`, iErr.message);
            }
          }
        }
      }
      log(`Successfully inserted ${insertedCount} ${layer.type} records!`);

    } catch (err) {
      logErr(`Error processing ${layer.type}:`, err);
    }
  }

  log('Retroactively tagging existing projects with administrative boundaries...');
  try {
    await Boundary.createIndexes().catch(e => logErr('Index creation warning:', e));
    const Project = require('../models/project');
    const projects = await Project.find({ 'centroid.coordinates': { $exists: true, $ne: [] } });
    log(`Found ${projects.length} projects with centroids to process.`);
    
    let updatedCount = 0;
    for (const project of projects) {
      try {
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
      } catch (pErr) {
        logErr(`Failed to intersect project ${project._id}:`, pErr.message);
      }
    }
    log(`Finished tagging ${updatedCount} projects with boundaries.`);
  } catch (err) {
    logErr('Error tagging projects with boundaries:', err);
  }
}

/**
 * Calculates square distance between a point and a line segment.
 */
function getSqSegDist(p, p1, p2) {
  let x = p1[0], y = p1[1];
  let dx = p2[0] - x, dy = p2[1] - y;

  if (dx !== 0 || dy !== 0) {
    let t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = p2[0];
      y = p2[1];
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }

  dx = p[0] - x;
  dy = p[1] - y;
  return dx * dx + dy * dy;
}

/**
 * Ramer-Douglas-Peucker polyline simplification algorithm.
 */
function simplifyRDP(points, sqTolerance) {
  const len = points.length;
  if (len <= 2) return points;

  let maxSqDist = 0;
  let index = 0;
  const end = len - 1;

  for (let i = 1; i < end; i++) {
    const sqDist = getSqSegDist(points[i], points[0], points[end]);
    if (sqDist > maxSqDist) {
      index = i;
      maxSqDist = sqDist;
    }
  }

  if (maxSqDist > sqTolerance) {
    const results1 = simplifyRDP(points.slice(0, index + 1), sqTolerance);
    const results2 = simplifyRDP(points.slice(index), sqTolerance);
    return results1.slice(0, results1.length - 1).concat(results2);
  }

  return [points[0], points[end]];
}

/**
 * Simplifies a GeoJSON Polygon or MultiPolygon geometry.
 * @param {Object} geometry - GeoJSON Polygon or MultiPolygon
 * @param {number} [tolerance=0.001] - Simplification tolerance in degrees
 */
function simplifyGeometry(geometry, tolerance = 0.001) {
  if (!geometry || !geometry.coordinates) return geometry;
  const sqTolerance = tolerance * tolerance;

  if (geometry.type === 'Polygon') {
    const newCoords = geometry.coordinates.map(ring => {
      if (ring.length <= 4) return ring; // Keep triangles and quads
      const simplified = simplifyRDP(ring, sqTolerance);
      // Keep closed rings intact
      if (simplified.length > 0 && (simplified[0][0] !== simplified[simplified.length - 1][0] || simplified[0][1] !== simplified[simplified.length - 1][1])) {
        simplified.push([simplified[0][0], simplified[0][1]]);
      }
      return simplified;
    });
    return { type: 'Polygon', coordinates: newCoords };
  } else if (geometry.type === 'MultiPolygon') {
    const newCoords = geometry.coordinates.map(polygon => {
      return polygon.map(ring => {
        if (ring.length <= 4) return ring;
        const simplified = simplifyRDP(ring, sqTolerance);
        if (simplified.length > 0 && (simplified[0][0] !== simplified[simplified.length - 1][0] || simplified[0][1] !== simplified[simplified.length - 1][1])) {
          simplified.push([simplified[0][0], simplified[0][1]]);
        }
        return simplified;
      });
    });
    return { type: 'MultiPolygon', coordinates: newCoords };
  }

  return geometry;
}

if (require.main === module) {
  require('dotenv').config();
  const mongoose = require('mongoose');
  const config = require('../config');
  mongoose.connect(config.mongoUri)
    .then(() => seedBoundaries())
    .then(() => mongoose.disconnect())
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Boundary seed failed:', err);
      process.exit(1);
    });
}

module.exports = { seedBoundaries };
