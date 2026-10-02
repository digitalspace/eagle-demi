'use strict';

/**
 * A sysadmin caller for suites that need one: the break-glass ADMIN_API_KEY, set for this test
 * process. src/helpers/auth.js has no built-in test key, so a suite that wants this caller says so
 * by requiring this file. `config.adminApiKey` is a getter read per request, so setting the
 * variable here is enough even after src/config has loaded.
 */

const SUITE_KEY = 'suite-break-glass-key';
process.env.ADMIN_API_KEY = SUITE_KEY;

module.exports = { SUITE_KEY };
