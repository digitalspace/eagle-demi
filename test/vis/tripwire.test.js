'use strict';

/**
 * The last line of defence, asserted on raw response TEXT rather than a parsed body.
 *
 * Every other test in this area drives a controller and inspects the object it returned. That
 * cannot see a field re-attached by middleware, a serializer, or an error path — and raw documents
 * now flow through error and log paths too (docs/rbac-architecture.md §2 item 1). So this boots the
 * real app, answers with a row carrying every restricted name at once, and greps the bytes.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const projects = require('../../src/repositories/projects');
const { logger } = require('../../src/utils/logger');
const { withServer } = require('../helpers/with-server');
const config = require('../../src/config');

config.enrichmentSources = ['wildfire'];

/** Substrings that must not appear in any anonymous response, as they are serialized. */
const FORBIDDEN = [
  '"read"',
  '"_rid"',
  '"_self"',
  '"_attachments"',
  '"_etag"',
  '"sources":{"track"',
  '"vis"'
];

/** One stored row carrying every restricted name, so one request tests all of them. */
const STORED = {
  id: '207',
  trackProjectId: 207,
  eagleId: '588511c4aaecd9001b826192',
  name: 'Nicomen Wind Energy',
  projectState: 'Operating',
  read: ['public', 'sysadmin', 'staff'],
  isPublished: true,
  vis: { name: 4 },
  sources: {
    track: { track_project_id: 207 },
    eagle: { _id: '588511c4aaecd9001b826192' },
    wildfire: { activeCountWithin50km: 2 }
  },
  _rid: 'abc==',
  _self: 'dbs/abc/colls/def/docs/ghi/',
  _attachments: 'attachments/',
  _ts: 1756000000,
  _etag: '"0x8DF00728"'
};

function assertClean(label, text) {
  for (const needle of FORBIDDEN) {
    assert.ok(!text.includes(needle), `${label}: response text carries ${needle}\n${text}`);
  }
}

test('no anonymous response carries a restricted field', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('the list, the point read and the search fallback are all clean', async () => {
    t.mock.method(projects, 'listVisible', async () => ({
      items: [structuredClone(STORED)], continuationToken: undefined
    }));
    t.mock.method(projects, 'getById', async () => structuredClone(STORED));
    t.mock.method(projects, 'countVisible', async () => 1);

    await withServer(async (base) => {
      for (const [label, url] of [
        ['point read', '/api/projects/207'],
        ['list', '/api/projects'],
        ['search', '/api/search?dataset=Project']
      ]) {
        const res = await fetch(`${base}${url}`);
        assert.strictEqual(res.status, 200, `${label} should answer 200`);
        const text = await res.text();
        assertClean(label, text);
        // Falsifiable in the other direction too: a response that lost the record entirely would
        // pass every assertion above.
        assert.ok(text.includes('Nicomen Wind Energy'), `${label}: the record itself survives`);
        assert.ok(text.includes('wildfire'), `${label}: the allowlisted aggregate survives`);
      }
    });
  });

  await t.test('an error response carries no raw document', async () => {
    // The driver message is the thing an error path leaks: it carries the Cosmos endpoint, the
    // database and container names, and the read routes reaching it need no credential.
    const failed = [];
    t.mock.method(logger, 'error', (message, meta) => { failed.push({ message, meta }); });
    t.mock.method(projects, 'getById', async () => {
      throw new Error(`Cosmos read failed for ${JSON.stringify(STORED)}`);
    });

    await withServer(async (base) => {
      const res = await fetch(`${base}/api/projects/207`);
      assert.strictEqual(res.status, 500);
      const text = await res.text();
      assertClean('error', text);
      assert.ok(!text.includes('Cosmos read failed'), 'the driver message stays in the log');
      assert.deepStrictEqual(JSON.parse(text), { success: false, error: 'Internal server error.' });
    });

    const line = failed.find(f => f.message === 'project controller failed');
    assert.ok(line, 'the failure is logged, not swallowed');
    assert.deepStrictEqual(Object.keys(line.meta).sort(), ['error', 'stack'],
      'the log line carries the error and its stack, never the document');
  });
});
