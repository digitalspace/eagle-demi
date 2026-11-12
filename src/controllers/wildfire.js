'use strict';

/**
 * Wildfire admin sync. No fire read route: the frontend reads the DataBC WFS directly, and DEMI
 * serves the `sources.wildfire` aggregate this sync patches onto each project.
 */

const syncWildfires = require('../scripts/sync-wildfires');
const { serverError } = require('../helpers/response');
const { auditEvent } = require('../utils/audit');

exports.syncWildfiresAdmin = async (req, res) => {
  try {
    // Called off the module object, not destructured, so a test can stand in for the network leg.
    const result = await syncWildfires.syncWildfiresData();

    // ONE row for the whole job: per-project rows would write the corpus size into a seven-year
    // table, and the counts in `detail` already say who rewrote the stats and when.
    auditEvent(req, {
      action: 'wildfire.sync',
      targetType: 'system',
      targetId: 'wildfires',
      detail: result
    });

    res.json({ success: true, result });
  } catch (err) {
    return serverError(res, err, 'wildfire sync failed');
  }
};
