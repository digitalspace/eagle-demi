'use strict';

const { SYNC_OUT_FIELDS } = require('./sync-out');

/**
 * Organization fields the Eagle mirror carries from the stored row instead of rebuilding. Visibility
 * moves only through DEMI publish and unpublish; a row the mirror creates starts from Eagle's `read`.
 */
const DEMI_OWNED_FIELDS = ['read', 'isPublished', ...SYNC_OUT_FIELDS];

const OWNERS = Object.freeze({ demi: DEMI_OWNED_FIELDS });

module.exports = { DEMI_OWNED_FIELDS, OWNERS };
