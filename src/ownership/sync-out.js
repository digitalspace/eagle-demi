'use strict';

// Sync-out state on a DEMI row it sends to Eagle. eagle-api echoes each send back through the
// mirror, so every mirror carries these from the stored row or sync-out sends the row again.
const SYNC_STATE_FIELDS = ['syncOut', 'syncVersion'];

// Documents and organizations key the row on the Eagle id, so theirs is stored state too. A project's
// comes from Track `epic_guid` or Eagle `_id`; only the echo carries it (`mergeEaglePush`).
const SYNC_OUT_FIELDS = [...SYNC_STATE_FIELDS, 'eagleId'];

module.exports = { SYNC_STATE_FIELDS, SYNC_OUT_FIELDS };
