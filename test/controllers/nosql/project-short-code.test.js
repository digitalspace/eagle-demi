'use strict';

/**
 * `PUT /api/projects/:id/short-code` — staff pick the project's `/s/<code>`. Printed codes must keep
 * resolving, so every assertion is on what reached the links and projects repositories.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const projects = require('../../../src/repositories/projects');
const links = require('../../../src/repositories/links');
const projectController = require('../../../src/controllers/nosql/project');
const config = require('../../../src/config');
const { logger } = require('../../../src/utils/logger');
const { mockRes, STAFF } = require('../../helpers/eagle-mirror-fixtures');

const EAGLE_ID = '58851172aaecd9001b820335';
const PAGE = `${config.linkBaseUrl}/p/${EAGLE_ID}`;

const stored = (overrides = {}) => ({
  id: '207',
  eagleId: EAGLE_ID,
  name: 'Nicomen Wind Energy',
  read: ['public'],
  isPublished: true,
  shortCode: 'nicomen-wind-energy',
  shortCodeSource: 'name',
  _etag: '"0x1"',
  ...overrides
});

const conflict = () => Object.assign(new Error('Conflict'), { code: 409 });
const lostRace = () => Object.assign(new Error('Precondition failed'), { code: 412 });

/**
 * Mocks both repositories over one stored row. `ids` are link records Cosmos already holds,
 * `owners` maps a code to the project ids claiming it, `upsert` replaces the default write.
 */
function setup(t, { project = stored(), ids = {}, owners = {}, upsert } = {}) {
  const created = [];
  const upserts = [];
  const linkRows = new Map(Object.entries(ids));
  const state = { row: project ? structuredClone(project) : null };
  t.mock.method(projects, 'getById', async () => structuredClone(state.row));
  t.mock.method(projects, 'upsert', upsert ? (row, opts) => upsert(row, opts, state) : async (row) => {
    upserts.push(row);
    state.row = row;
    return row;
  });
  t.mock.method(projects, 'listShortCodeOwners', async (code) => owners[code] || []);
  t.mock.method(links, 'create', async (record) => {
    if (linkRows.has(record.id)) throw conflict();
    created.push(record);
    linkRows.set(record.id, record);
    return record;
  });
  t.mock.method(links, 'getById', async (id) => linkRows.get(id) || null);
  t.mock.method(links, 'remove', async () => { throw new Error('a printed code is never deleted'); });
  return { created, upserts, state, linkRows };
}

const setCode = async (shortCode) => {
  const res = mockRes();
  await projectController.setShortCode(
    { params: { id: '207' }, query: {}, user: STAFF, body: { shortCode } }, res);
  return res;
};

test('PUT /projects/:id/short-code', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('sets the code, mints its link, and keeps the old one as legacy', async (t) => {
    const { created, upserts } = setup(t);
    const info = t.mock.method(logger, 'info', () => {});

    const res = await setCode('Site-C');

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, {
      shortCode: 'site-c',
      shortUrl: `${config.linkBaseUrl}/s/site-c`,
      legacyShortCodes: ['nicomen-wind-energy']
    });
    assert.deepStrictEqual(created.map(l => [l.id, l.url, l.createdBy]), [['site-c', PAGE, 'push']]);
    assert.strictEqual(upserts[0].shortCodeSource, 'staff', 'the sync must leave it alone');
    const logged = info.mock.calls.find(c => /short code changed/.test(c.arguments[0]));
    assert.deepStrictEqual(
      { by: logged.arguments[1].by, from: logged.arguments[1].from, to: logged.arguments[1].to },
      { by: 'push', from: 'nicomen-wind-energy', to: 'site-c' });
  });

  await t.test('an invalid code is a 400 and writes nothing', async (t) => {
    const { created, upserts } = setup(t);

    const res = await setCode('site c!');

    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.error);
    assert.deepStrictEqual([created, upserts], [[], []]);
  });

  await t.test('a missing code is a 400', async (t) => {
    setup(t);

    assert.strictEqual((await setCode(undefined)).statusCode, 400);
  });

  await t.test('another project\'s code is a 409, never suffixed', async (t) => {
    const { upserts } = setup(t, {
      ids: { kemess: { id: 'kemess', url: `${config.linkBaseUrl}/p/other` } },
      owners: { kemess: ['300'] }
    });

    const res = await setCode('kemess');

    assert.strictEqual(res.statusCode, 409);
    assert.deepStrictEqual(res.body, { error: 'Code already in use' });
    assert.deepStrictEqual(upserts, []);
  });

  await t.test('a record at this page that another project claims is still a 409', async (t) => {
    setup(t, {
      ids: { kemess: { id: 'kemess', url: PAGE } },
      owners: { kemess: [`eagle-${EAGLE_ID}`] }
    });

    assert.strictEqual((await setCode('kemess')).statusCode, 409);
  });

  await t.test('moving back to one of its own legacy codes reuses that record', async (t) => {
    const project = stored({
      shortCode: 'site-c', shortCodeSource: 'staff', legacyShortCodes: ['nicomen-wind-energy']
    });
    const { created, upserts } = setup(t, {
      project,
      ids: { 'nicomen-wind-energy': { id: 'nicomen-wind-energy', url: PAGE } },
      owners: { 'nicomen-wind-energy': ['207'] }
    });

    const res = await setCode('nicomen-wind-energy');

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(upserts[0].shortCode, 'nicomen-wind-energy');
    assert.deepStrictEqual(res.body.legacyShortCodes, ['site-c']);
    assert.deepStrictEqual(created, []);
  });

  await t.test('re-sending the current staff code is a no-op 200', async (t) => {
    const { created, upserts } = setup(t, {
      project: stored({ shortCode: 'site-c', shortCodeSource: 'staff' })
    });

    const res = await setCode('site-c');

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.shortCode, 'site-c');
    assert.deepStrictEqual([created, upserts], [[], []]);
  });

  await t.test('re-sending a pre-slug random code pins it as staff', async (t) => {
    const project = stored({ shortCode: 'kq7bt2rm' });
    delete project.shortCodeSource;
    const { created, upserts } = setup(t, { project });

    const res = await setCode('kq7bt2rm');

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(upserts[0].shortCodeSource, 'staff', 'or the sync would migrate it away');
    assert.strictEqual(upserts[0].shortCode, 'kq7bt2rm');
    assert.deepStrictEqual(upserts[0].legacyShortCodes, []);
    assert.deepStrictEqual(created, []);
  });

  await t.test('a lost race rebuilds off the re-read row, keeping its new legacy code', async (t) => {
    let calls = 0;
    const { upserts } = setup(t, {
      upsert: async (row, _opts, state) => {
        if (calls++ === 0) {
          state.row = { ...state.row, legacyShortCodes: ['abcd2345'], _etag: '"0x2"' };
          throw lostRace();
        }
        upserts.push(row);
        return row;
      }
    });

    const res = await setCode('site-c');

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(upserts[0].legacyShortCodes, ['abcd2345', 'nicomen-wind-energy']);
  });

  await t.test('a write that ends 503 leaves a record the retry adopts', async (t) => {
    let failing = true;
    const { created, upserts, linkRows } = setup(t, {
      upsert: async (row) => {
        if (failing) throw lostRace();
        upserts.push(row);
        return row;
      }
    });

    const first = await setCode('site-c');
    failing = false;
    const retry = await setCode('site-c');

    assert.strictEqual(first.statusCode, 503);
    assert.ok(linkRows.has('site-c'), 'the premise: the link landed before the write failed');
    assert.strictEqual(retry.statusCode, 200, 'its own leftover is not "already in use"');
    assert.strictEqual(upserts[0].shortCode, 'site-c');
    assert.strictEqual(created.length, 1);
  });

  await t.test('an unknown project is a 404', async (t) => {
    setup(t, { project: null });

    assert.strictEqual((await setCode('site-c')).statusCode, 404);
  });

  await t.test('a project with no Eagle id has no page to point at, so 400', async (t) => {
    const { created } = setup(t, { project: stored({ eagleId: null, shortCode: undefined }) });

    assert.strictEqual((await setCode('site-c')).statusCode, 400);
    assert.deepStrictEqual(created, []);
  });
});

test('the short code outside its own route', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a rename through PUT /projects/:id keeps the code', async (t) => {
    const { upserts } = setup(t);

    await projectController.updateProject({
      params: { id: '207' }, query: {}, user: STAFF,
      body: { name: 'Nicomen Wind Energy Phase Two', shortCode: 'other', legacyShortCodes: [] }
    }, mockRes());

    assert.strictEqual(upserts[0].name, 'Nicomen Wind Energy Phase Two');
    assert.strictEqual(upserts[0].shortCode, 'nicomen-wind-energy',
      'a code with no link record behind it would be a dead print');
  });

  await t.test('a POST over an existing id keeps its codes', async (t) => {
    const { upserts } = setup(t, {
      project: stored({ shortCode: 'site-c', shortCodeSource: 'staff', legacyShortCodes: ['kq7bt2rm'] })
    });

    await projectController.createProject({
      params: {}, query: {}, user: STAFF,
      body: { trackProjectId: 207, name: 'Nicomen Wind Energy', centroid: { coordinates: [-121.4, 50.2] } }
    }, mockRes());

    assert.deepStrictEqual(
      [upserts[0].shortCode, upserts[0].shortCodeSource, upserts[0].legacyShortCodes],
      ['site-c', 'staff', ['kq7bt2rm']]);
    assert.strictEqual(upserts[0].isPublished, false, 'the create itself is unchanged');
  });

  await t.test('GET /projects/:id carries the legacy codes to everyone', async (t) => {
    setup(t, { project: stored({ legacyShortCodes: ['kq7bt2rm'] }) });
    const res = mockRes();

    await projectController.getProject({ params: { id: '207' }, query: {} }, res);

    assert.deepStrictEqual(res.body.legacyShortCodes, ['kq7bt2rm']);
    assert.strictEqual(res.body.shortUrl, `${config.linkBaseUrl}/s/nicomen-wind-energy`);
  });

  await t.test('shortCodeSource is staff bookkeeping, hidden from the public', async (t) => {
    setup(t);
    const anonymous = mockRes();
    const staff = mockRes();

    await projectController.getProject({ params: { id: '207' }, query: {} }, anonymous);
    await projectController.getProject({ params: { id: '207' }, query: {}, user: STAFF }, staff);

    assert.ok(!('shortCodeSource' in anonymous.body));
    assert.strictEqual(staff.body.shortCodeSource, 'name');
  });
});
