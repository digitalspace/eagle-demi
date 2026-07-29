'use strict';

const Wildfire = require('../models/wildfire');
const { syncWildfiresData } = require('../scripts/sync-wildfires');

exports.getWildfires = async (req, res) => {
  try {
    const { status, fireOfNote, format, nearLng, nearLat, radiusKm } = req.query;

    const filter = {};
    if (status) filter.fireStatus = status;
    if (fireOfNote === 'true') filter.isFireOfNote = true;

    if (nearLng && nearLat) {
      const lng = parseFloat(nearLng);
      const lat = parseFloat(nearLat);
      const maxDistMeters = (parseFloat(radiusKm) || 50) * 1000;

      if (!isNaN(lng) && !isNaN(lat)) {
        filter.location = {
          $near: {
            $geometry: { type: 'Point', coordinates: [lng, lat] },
            $maxDistance: maxDistMeters
          }
        };
      }
    }

    // No .lean() — Wildfire is a plain repository returning an array, not a Mongoose query.
    // Note: a $near filter needs a geospatial index on Cosmos; without one queryContainer
    // logs the rejection and returns [], so a location search degrades to "no results"
    // rather than an error.
    const wildfires = await Wildfire.find(filter);

    if (format === 'geojson') {
      return res.json({
        type: 'FeatureCollection',
        features: wildfires.map(w => ({
          type: 'Feature',
          geometry: w.perimeterGeoJson || w.location,
          properties: {
            fireNumber: w.fireNumber,
            fireYear: w.fireYear,
            incidentName: w.incidentName,
            geographicDescription: w.geographicDescription,
            fireStatus: w.fireStatus,
            fireCause: w.fireCause,
            currentSizeHectares: w.currentSizeHectares,
            fireUrl: w.fireUrl,
            isFireOfNote: w.isFireOfNote,
            location: w.location,
            syncedAt: w.syncedAt
          }
        }))
      });
    }

    res.json(wildfires);
  } catch (err) {
    console.error('[Wildfire Controller] Error fetching wildfires:', err);
    res.status(500).json({ error: 'Failed to fetch wildfire data' });
  }
};

exports.syncWildfiresAdmin = async (req, res) => {
  try {
    // syncWildfiresData() takes no arguments — it uses the shared repository directly.
    const result = await syncWildfiresData();
    res.json({ success: true, result });
  } catch (err) {
    console.error('[Wildfire Controller] Admin sync error:', err);
    res.status(500).json({ error: err.message });
  }
};
