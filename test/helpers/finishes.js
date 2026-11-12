'use strict';

const { spawnSync } = require('node:child_process');

/**
 * Whether `expression` finishes in a child process, with `m` the module at `modulePath`. A test
 * runner cannot stop a busy synchronous call, so the scan runs where a timeout can kill it.
 */
function finishes(modulePath, expression, timeout = 15000) {
  const code = `const m = require(${JSON.stringify(modulePath)}); ${expression};`;
  return spawnSync(process.execPath, ['-e', code], { timeout }).status === 0;
}

module.exports = { finishes };
