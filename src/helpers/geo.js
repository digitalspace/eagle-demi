'use strict';

/**
 * Parses a bbox string (either JSON string or CSV 'west,south,east,north')
 * into a GeoJSON Polygon object.
 *
 * @param {string} bbox - The bounding box input parameter
 * @returns {object|null} GeoJSON Polygon geometry or null if invalid
 */
function parseBboxPolygon(bbox) {
  if (!bbox || typeof bbox !== 'string') return null;

  try {
    const trimmed = bbox.trim();
    if (trimmed.startsWith('{')) {
      return JSON.parse(trimmed);
    }

    const [west, south, east, north] = trimmed.split(',').map(Number);
    if (!isNaN(west) && !isNaN(south) && !isNaN(east) && !isNaN(north)) {
      return {
        type: 'Polygon',
        coordinates: [[
          [west, south],
          [east, south],
          [east, north],
          [west, north],
          [west, south]
        ]]
      };
    }
  } catch (e) {
    // Graceful fallback for malformed bounding box inputs
  }

  return null;
}

module.exports = {
  parseBboxPolygon
};
