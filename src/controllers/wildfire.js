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

const syncWildfires = require('../scripts/sync-wildfires');
const { serverError } = require('../helpers/response');
const { auditEvent } = require('../utils/audit');

exports.syncWildfiresAdmin = async (req, res) => {
  try {
    // syncWildfiresData() takes no arguments — it uses the shared repositories directly.
    // Called off the module object, not destructured, so a test can stand in for the network leg.
    const result = await syncWildfires.syncWildfiresData();

    // ONE row for a job that patches every project (sync-wildfires.js) and upserts every fire.
    // Per-project rows would write the corpus size into a seven-year table to answer a question
    // that is only ever "who triggered a full rewrite of the wildfire stats, and when" — which the
    // counts in `detail` already answer.
    auditEvent(req, {
      action: 'wildfire.sync',
      targetType: 'system',
      targetId: 'wildfires',
      detail: result
    });

    res.json({ success: true, result });
  } catch (err) {
    // serverError, like every other controller: the old line echoed err.message straight back, so
    // a DataBC or Cosmos internal reached the caller on a route that is authenticated but not
    // therefore trusted. serverError already logs message + stack and answers generically.
    return serverError(res, err, 'wildfire sync failed');
  }
};
