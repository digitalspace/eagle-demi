'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../config');
const Boundary = require('../models/boundary');

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
 */
function simplifyGeometry(geometry, tolerance = 0.001) {
  if (!geometry || !geometry.coordinates) return geometry;
  const sqTolerance = tolerance * tolerance;

  if (geometry.type === 'Polygon') {
    const newCoords = geometry.coordinates.map(ring => {
      if (ring.length <= 4) return ring; // Keep triangles and quads
      const simplified = simplifyRDP(ring, sqTolerance);
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

async function run() {
  console.log('[Migration] Connecting to MongoDB database...');
  await mongoose.connect(config.mongoUri);
  console.log('[Migration] Connection successful.');

  // Find all boundaries where simplifiedGeometry is null, missing, or coordinates is not set
  const query = {
    $or: [
      { simplifiedGeometry: { $exists: false } },
      { simplifiedGeometry: null },
      { 'simplifiedGeometry.coordinates': { $exists: false } },
      { 'simplifiedGeometry.coordinates': null }
    ]
  };

  const boundaries = await Boundary.find(query);
  console.log(`[Migration] Found ${boundaries.length} boundary documents requiring geometry pre-simplification.`);

  if (boundaries.length === 0) {
    console.log('[Migration] All administrative boundaries are already pre-simplified. No remediation required!');
    await mongoose.disconnect();
    return;
  }

  let count = 0;
  for (const doc of boundaries) {
    if (!doc.geometry || !doc.geometry.coordinates) {
      console.warn(`[Migration] Document ${doc._id} (${doc.name}) is missing raw geometry. Skipping.`);
      continue;
    }

    try {
      doc.simplifiedGeometry = simplifyGeometry(doc.geometry, 0.001); // 0.001 degrees tolerance (~111 meters)
      // Save without executing validators or pre-save hooks to maximize throughput
      await Boundary.updateOne(
        { _id: doc._id },
        { $set: { simplifiedGeometry: doc.simplifiedGeometry } }
      );
      
      count++;
      if (count % 20 === 0 || count === boundaries.length) {
        console.log(`[Migration] Remediation progress: ${count}/${boundaries.length} documents processed.`);
      }
    } catch (err) {
      console.error(`[Migration] Failed to process document ${doc._id} (${doc.name}):`, err.message);
    }
  }

  console.log(`[Migration] Successful. Remediation populated ${count} administrative boundary documents.`);
  await mongoose.disconnect();
  console.log('[Migration] Disconnected from database.');
}

run().catch(err => {
  console.error('[Migration] Remediation failed:', err);
  process.exit(1);
});
