'use strict';

/**
 * The break-glass ADMIN_API_KEY for this test process; src/helpers/auth.js has no built-in test key.
 * `config.adminApiKey` is read per request, so setting it here works even after src/config loaded.
 */

const SUITE_KEY = 'suite-break-glass-key';
process.env.ADMIN_API_KEY = SUITE_KEY;

module.exports = { SUITE_KEY };
