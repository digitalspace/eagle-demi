'use strict';

/**
 * Wildfire admin sync.
 *
 * `GET /wildfires` is gone. Nothing consumed it — the frontend's fire layer reads the DataBC WFS
 * directly (map-explorer.component.ts), and what DEMI serves is the `sources.wildfire` aggregate
 * this sync patches onto each project. The endpoint's `$near` filter also depended on a Mongo
 * geospatial index that, when absent, made a location search return `[]` rather than an error —
 * a read path that failed silently and that no caller would have noticed.
 */

const { syncWildfiresData } = require('../scripts/sync-wildfires');
const { logger } = require('../utils/logger');

exports.syncWildfiresAdmin = async (req, res) => {
  try {
    // syncWildfiresData() takes no arguments — it uses the shared repositories directly.
    const result = await syncWildfiresData();
    res.json({ success: true, result });
  } catch (err) {
    logger.error('[Wildfire Controller] Admin sync error:', { error: err.message, stack: err.stack });
    res.status(500).json({ error: err.message });
  }
};
