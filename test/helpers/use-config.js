'use strict';

const config = require('../../src/config');

/** Set `overrides` on src/config for one test, restoring each value after it. */
function useConfig(t, overrides) {
  const previous = Object.fromEntries(Object.keys(overrides).map(k => [k, config[k]]));
  Object.assign(config, overrides);
  t.after(() => { Object.assign(config, previous); });
}

module.exports = { useConfig };
