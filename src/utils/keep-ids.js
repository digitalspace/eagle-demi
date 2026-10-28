'use strict';

const fs = require('fs');

/**
 * The `--keep-ids` file format: one id per line, blank lines and `#` comments skipped, duplicates
 * dropped, file order kept. Cosmos ids cannot contain `#`.
 */
function parseKeepIds(text) {
  return [...new Set(text.split('\n')
    .map(line => line.replace(/#.*/, '').trim())
    .filter(Boolean))];
}

/** Throws the fs error (ENOENT and the like) when the file cannot be read. */
function readKeepIds(file) {
  return parseKeepIds(fs.readFileSync(file, 'utf8'));
}

module.exports = { parseKeepIds, readKeepIds };
