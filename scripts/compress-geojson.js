'use strict';

const fs = require('fs');
const path = require('path');

const inputFile = path.join(__dirname, '../frontend/public/env_regional_boundaries_reprojected.geojson');
const outputFile = inputFile; // Overwrite in-place or write to same path

if (!fs.existsSync(inputFile)) {
  console.error(`Input file not found: ${inputFile}`);
  process.exit(1);
}

console.log(`Reading ${inputFile}...`);
const stats = fs.statSync(inputFile);
console.log(`Original file size: ${(stats.size / (1024 * 1024)).toFixed(2)} MB`);

const rawData = JSON.parse(fs.readFileSync(inputFile, 'utf8'));

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
 * Simplifies coordinates with given tolerance in degrees (~0.005 deg = ~500m).
 * Also rounds coordinates to 4 decimal places for maximum byte efficiency.
 */
function simplifyGeometry(geometry, tolerance = 0.005) {
  if (!geometry || !geometry.coordinates) return geometry;
  const sqTolerance = tolerance * tolerance;

  const formatPoint = (p) => [
    Math.round(p[0] * 10000) / 10000,
    Math.round(p[1] * 10000) / 10000
  ];

  if (geometry.type === 'Polygon') {
    const newCoords = geometry.coordinates.map(ring => {
      if (ring.length <= 4) return ring.map(formatPoint);
      const simplified = simplifyRDP(ring, sqTolerance).map(formatPoint);
      if (simplified.length > 0 && (simplified[0][0] !== simplified[simplified.length - 1][0] || simplified[0][1] !== simplified[simplified.length - 1][1])) {
        simplified.push([simplified[0][0], simplified[0][1]]);
      }
      return simplified;
    });
    return { type: 'Polygon', coordinates: newCoords };
  } else if (geometry.type === 'MultiPolygon') {
    const newCoords = geometry.coordinates.map(polygon => {
      return polygon.map(ring => {
        if (ring.length <= 4) return ring.map(formatPoint);
        const simplified = simplifyRDP(ring, sqTolerance).map(formatPoint);
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

if (rawData.features && Array.isArray(rawData.features)) {
  console.log(`Simplifying ${rawData.features.length} features with tolerance 0.005° (~500m)...`);
  rawData.features = rawData.features.map(f => ({
    ...f,
    geometry: simplifyGeometry(f.geometry, 0.005)
  }));
}

const compressedContent = JSON.stringify(rawData);
fs.writeFileSync(outputFile, compressedContent, 'utf8');

const newStats = fs.statSync(outputFile);
console.log(`Compressed file size: ${(newStats.size / (1024 * 1024)).toFixed(2)} MB (${(newStats.size / 1024).toFixed(1)} KB)`);
console.log(`Reduction: ${(((stats.size - newStats.size) / stats.size) * 100).toFixed(2)}%`);
