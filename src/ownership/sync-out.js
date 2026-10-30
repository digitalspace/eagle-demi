'use strict';

// Sync-out state on any DEMI row it sends to Eagle. eagle-api echoes each send back through the
// mirror, so every mirror carries these from the stored row or sync-out sends the row again.
const SYNC_OUT_FIELDS = ['syncOut', 'syncVersion', 'eagleId'];

module.exports = { SYNC_OUT_FIELDS };
