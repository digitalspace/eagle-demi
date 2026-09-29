'use strict';

const test = require('node:test');
const assert = require('node:assert');

const searchController = require('../../src/controllers/search');
const { logger } = require('../../src/utils/logger');

// Keyed per dataset AND reason: an index going missing after the switch was off is a new fault.
test('keyword fallback warning latches once per dataset and reason', (t) => {
  searchController.resetKeywordFallbackWarnings();
  t.after(() => searchController.resetKeywordFallbackWarnings());
  const warned = [];
  t.mock.method(logger, 'warn', (msg) => warned.push(String(msg)));

  searchController.warnKeywordFallback('RecentActivity', 'off');
  searchController.warnKeywordFallback('RecentActivity', 'missing');
  assert.strictEqual(warned.length, 2, `each reason must log its own line, got: ${JSON.stringify(warned)}`);
  assert.match(warned[0], /RecentActivity.*index app setting for this dataset is empty/);
  assert.match(warned[1], /RecentActivity.*does not exist on the search service/);

  searchController.warnKeywordFallback('RecentActivity', 'off');
  searchController.warnKeywordFallback('RecentActivity', 'missing');
  assert.strictEqual(warned.length, 2, 'a repeat of either reason must log nothing');

  searchController.warnKeywordFallback('ProjectNotification', 'off');
  assert.strictEqual(warned.length, 3, 'the same reason on another dataset must log its own line');
  assert.match(warned[2], /ProjectNotification.*index app setting for this dataset is empty/);
});
