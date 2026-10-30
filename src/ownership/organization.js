'use strict';

const { SYNC_OUT_FIELDS } = require('./sync-out');

/** Organization fields the Eagle mirror carries from the stored row instead of rebuilding. */
const DEMI_OWNED_FIELDS = [...SYNC_OUT_FIELDS];

const OWNERS = Object.freeze({ demi: DEMI_OWNED_FIELDS });

module.exports = { DEMI_OWNED_FIELDS, OWNERS };
