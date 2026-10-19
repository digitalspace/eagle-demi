'use strict';

// GET /sitemap.xml end to end through the dispatcher, over a fake Cosmos that applies the read
// predicate's role parameters the way the `read[]` clause does.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');

const config = require('../../src/config');
const cosmos = require('../../src/db/cosmos-nosql');
const sitemap = require('../../src/controllers/sitemap');
const { logger } = require('../../src/utils/logger');
const { withServer } = require('../helpers/with-server');

const HOST = 'https://projects.example.gov.bc.ca';
const A = '5c1f7a3e9b1d2c0012390001';
const B = '5c1f7a3e9b1d2c0012390002';
const C = '5c1f7a3e9b1d2c0012390003';

const ROWS = [
  // Track row and its `eagle-<id>` twin: one page, the later date.
  { id: '207', eagleId: B, dateUpdated: '2026-03-01T10:00:00.000Z', read: ['public'] },
  { id: `eagle-${B}`, eagleId: B, dateUpdated: '2026-05-02T10:00:00.000Z', read: ['public'] },
  { id: `eagle-${A}`, eagleId: A, dateUpdated: '2026-01-15T22:30:00.000Z', read: ['public'] },
  { id: `eagle-${C}`, eagleId: C, dateUpdated: null, read: ['public'] },
  // Unpublished: staff only.
  { id: 'eagle-5c1f7a3e9b1d2c0012390004', eagleId: '5c1f7a3e9b1d2c0012390004', read: ['staff', 'sysadmin'] },
  // Public, but Track only: eagle-public has no `/p/` page for it.
  { id: '311', eagleId: null, dateUpdated: '2026-02-02T00:00:00.000Z', read: ['public'] }
];

/** Fake Cosmos: answers the rows whose `read[]` holds one of the query's role parameters. */
function fakeCosmos(t, rows = ROWS) {
  const specs = [];
  t.mock.method(cosmos, 'query', async (container, spec) => {
    specs.push({ container, spec });
    const roles = spec.parameters.filter(p => p.name.startsWith('@role')).map(p => p.value);
    return { items: rows.filter(row => row.read.some(r => roles.includes(r))).map(row => ({ ...row })) };
  });
  return specs;
}

async function get(headers = {}) {
  let result;
  await withServer(async (call) => {
    const res = await call('/api/sitemap.xml', { headers });
    result = { status: res.status, headers: res.headers, body: await res.text() };
  });
  return result;
}

const locs = xml => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);

test('GET /sitemap.xml', async (t) => {
  t.beforeEach((t) => {
    sitemap._resetCache();
    const linkBaseUrl = config.linkBaseUrl;
    const keycloakEnabled = config.keycloakEnabled;
    config.linkBaseUrl = HOST;
    config.keycloakEnabled = false;
    t.after(() => {
      config.linkBaseUrl = linkBaseUrl;
      config.keycloakEnabled = keycloakEnabled;
    });
  });
  t.afterEach(() => t.mock.restoreAll());

  await t.test('lists each public Eagle project page once, by Eagle id, with its lastmod', async (t) => {
    fakeCosmos(t);
    const res = await get();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'application/xml; charset=utf-8');
    assert.strictEqual(res.headers.get('cache-control'), 'public, max-age=3600');
    assert.strictEqual(res.body,
      '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
      + `  <url>\n    <loc>${HOST}/p/${A}</loc>\n    <lastmod>2026-01-15</lastmod>\n  </url>\n`
      + `  <url>\n    <loc>${HOST}/p/${B}</loc>\n    <lastmod>2026-05-02</lastmod>\n  </url>\n`
      + `  <url>\n    <loc>${HOST}/p/${C}</loc>\n  </url>\n`
      + '</urlset>\n');
  });

  await t.test('reads as an anonymous caller, whatever credential the request carries', async (t) => {
    const specs = fakeCosmos(t);
    const token = jwt.sign({ sub: 'kc-1', realm_access: { roles: ['staff', 'sysadmin'] } }, 'suite-only');
    const res = await get({ authorization: `Bearer ${token}` });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(specs.length, 1);
    assert.strictEqual(specs[0].container, 'projects');
    const roles = specs[0].spec.parameters.filter(p => p.name.startsWith('@role')).map(p => p.value);
    assert.deepStrictEqual(roles, ['public']);
    assert.ok(!locs(res.body).some(loc => loc.endsWith('/p/5c1f7a3e9b1d2c0012390004')), 'unpublished project listed');
  });

  await t.test('a date the row hides from anonymous readers is left out', async (t) => {
    fakeCosmos(t, [{ id: `eagle-${A}`, eagleId: A, dateUpdated: '2026-01-15T00:00:00.000Z', vis: { dateUpdated: 2 }, read: ['public'] }]);
    const res = await get();
    assert.deepStrictEqual(locs(res.body), [`${HOST}/p/${A}`]);
    assert.ok(!res.body.includes('<lastmod>'), res.body);
  });

  await t.test('builds once an hour; concurrent requests share the build', async (t) => {
    const specs = fakeCosmos(t);
    let now = Date.parse('2026-10-19T12:00:00Z');
    t.mock.method(Date, 'now', () => now);
    await Promise.all([get(), get()]);
    now += 59 * 60 * 1000;
    await get();
    assert.strictEqual(specs.length, 1);
    now += 60 * 1000;
    await get();
    assert.strictEqual(specs.length, 2);
  });

  await t.test('a failed build answers 500 and is not cached', async (t) => {
    let fail = true;
    const rows = ROWS;
    t.mock.method(cosmos, 'query', async () => {
      if (fail) throw new Error('cosmos down at https://account.documents.azure.com');
      return { items: rows.filter(row => row.read.includes('public')) };
    });
    const failed = await get();
    assert.strictEqual(failed.status, 500);
    assert.ok(!failed.body.includes('cosmos down'), failed.body);
    fail = false;
    const retried = await get();
    assert.strictEqual(retried.status, 200);
    assert.strictEqual(locs(retried.body).length, 3);
  });

  await t.test('stops at 50,000 entries and warns', async (t) => {
    const rows = Array.from({ length: 50001 }, (_, i) => {
      const eagleId = i.toString(16).padStart(24, '0');
      return { id: `eagle-${eagleId}`, eagleId, read: ['public'] };
    });
    fakeCosmos(t, rows);
    const warn = t.mock.method(logger, 'warn', () => {});
    const res = await get();
    const listed = locs(res.body);
    assert.strictEqual(listed.length, 50000);
    assert.strictEqual(listed.at(-1), `${HOST}/p/${(49999).toString(16).padStart(24, '0')}`);
    assert.strictEqual(warn.mock.callCount(), 1);
    assert.deepStrictEqual(warn.mock.calls[0].arguments[1], { count: 50001, limit: 50000 });
  });
});
