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
const CUSTOM = 'https://www2.gov.bc.ca/gov/content/site-c';

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
 * Mocks both repositories over one stored row. `ids` are link records Cosmos already holds, on top
 * of one per code the row holds at its target; `owners` maps a code to the project ids claiming
 * it, `upsert` replaces the default write, `moved` lists codes whose record changed since read, so
 * their repoint 412s.
 */
function setup(t, { project = stored(), ids = {}, owners = {}, upsert, moved = new Set() } = {}) {
  const created = [];
  const upserts = [];
  const held = project ? [project.shortCode, ...(project.legacyShortCodes || [])].filter(Boolean) : [];
  const linkRows = new Map([
    ...held.map(code => [code, { id: code, url: project.shortLinkUrl || PAGE, createdBy: 'system' }]),
    ...Object.entries(ids)
  ]);
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
  t.mock.method(links, 'repoint', async (code, url, { claimedBy } = {}) => {
    if (moved.has(code)) throw lostRace();
    if (!linkRows.has(code)) return null;
    const row = { ...linkRows.get(code), url, ...(claimedBy ? { claimedBy } : {}) };
    linkRows.set(code, row);
    return row;
  });
  return { created, upserts, state, linkRows };
}

const setShortLink = async (body) => {
  const res = mockRes();
  await projectController.setShortCode({ params: { id: '207' }, query: {}, user: STAFF, body }, res);
  return res;
};
const setCode = (shortCode) => setShortLink({ shortCode });
const setUrl = (url) => setShortLink({ url });

/** A project with a current and a legacy code, both records on the public page. */
const withLegacy = (overrides = {}) => ({
  project: stored({ legacyShortCodes: ['kq7bt2rm'], ...overrides }),
  ids: {
    'nicomen-wind-energy': { id: 'nicomen-wind-energy', url: PAGE, _etag: '"l1"' },
    kq7bt2rm: { id: 'kq7bt2rm', url: PAGE, _etag: '"l2"' }
  }
});

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
      legacyShortCodes: ['nicomen-wind-energy'],
      url: PAGE,
      shortLinkCustom: false
    });
    assert.deepStrictEqual(created.map(l => [l.id, l.url, l.createdBy]), [['site-c', PAGE, 'push']]);
    assert.strictEqual(upserts[0].shortCodeSource, 'staff', 'the sync must leave it alone');
    const logged = info.mock.calls.find(c => /short link changed/.test(c.arguments[0]));
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
      owners: { kemess: ['208'] }
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

  await t.test('a url repoints the current and every legacy record, and is stored', async (t) => {
    const { upserts, linkRows } = setup(t, withLegacy());
    const info = t.mock.method(logger, 'info', () => {});

    const res = await setUrl(CUSTOM);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, {
      shortCode: 'nicomen-wind-energy',
      shortUrl: `${config.linkBaseUrl}/s/nicomen-wind-energy`,
      legacyShortCodes: ['kq7bt2rm'],
      url: CUSTOM,
      shortLinkCustom: true
    });
    assert.strictEqual(upserts[0].shortLinkUrl, CUSTOM);
    assert.strictEqual(upserts[0].shortCodeSource, 'name', 'a url alone does not pin the code');
    assert.deepStrictEqual([linkRows.get('nicomen-wind-energy').url, linkRows.get('kq7bt2rm').url],
      [CUSTOM, CUSTOM], 'a printed legacy code follows the project');
    const logged = info.mock.calls.find(c => /short link changed/.test(c.arguments[0])).arguments[1];
    assert.deepStrictEqual(logged, {
      id: '207', by: 'push', from: 'nicomen-wind-energy', to: 'nicomen-wind-energy',
      fromUrl: PAGE, toUrl: CUSTOM
    });
  });

  await t.test('url null resets every record to the public page', async (t) => {
    const setupOpts = withLegacy({ shortLinkUrl: CUSTOM });
    for (const record of Object.values(setupOpts.ids)) record.url = CUSTOM;
    const { upserts, linkRows } = setup(t, setupOpts);

    const res = await setUrl(null);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.url, PAGE);
    assert.strictEqual(upserts[0].shortLinkUrl, null);
    assert.deepStrictEqual([linkRows.get('nicomen-wind-energy').url, linkRows.get('kq7bt2rm').url],
      [PAGE, PAGE]);
  });

  await t.test('a url off the allowlist is a 400 and writes nothing', async (t) => {
    const { created, upserts } = setup(t);
    const repoint = links.repoint;

    const res = await setUrl('https://example.com/phish');

    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /allowlist/);
    assert.deepStrictEqual([created, upserts, repoint.mock.callCount()], [[], [], 0]);
  });

  await t.test('a body with neither shortCode nor url is a 400', async (t) => {
    const { upserts } = setup(t);

    const res = await setShortLink({});

    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.error);
    assert.deepStrictEqual(upserts, []);
  });

  await t.test('a record that moved under the repoint is a 503, and the retry finishes it', async (t) => {
    const moved = new Set(['kq7bt2rm']);
    const { upserts, linkRows, state } = setup(t, { ...withLegacy(), moved });

    const first = await setUrl(CUSTOM);

    assert.strictEqual(first.statusCode, 503);
    assert.ok(first.body.error);
    assert.strictEqual(state.row.shortLinkUrl, CUSTOM, 'the project row is saved whole');
    assert.strictEqual(linkRows.get('kq7bt2rm').url, PAGE);

    moved.clear();
    const retry = await setUrl(CUSTOM);

    assert.strictEqual(retry.statusCode, 200);
    assert.strictEqual(upserts.length, 1, 'the retry has nothing to write on the project');
    assert.strictEqual(linkRows.get('kq7bt2rm').url, CUSTOM);
  });

  await t.test('a code change mints the new record at the custom target', async (t) => {
    const { created } = setup(t, { project: stored({ shortLinkUrl: CUSTOM }) });

    const res = await setCode('site-c');

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(created.map(l => [l.id, l.url]), [['site-c', CUSTOM]]);
    assert.strictEqual(res.body.url, CUSTOM);
  });

  await t.test('code and url together land the new code at the new url', async (t) => {
    const { created, upserts } = setup(t);

    const res = await setShortLink({ shortCode: 'site-c', url: CUSTOM });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(created.map(l => [l.id, l.url]), [['site-c', CUSTOM]]);
    assert.deepStrictEqual([upserts[0].shortCode, upserts[0].shortLinkUrl], ['site-c', CUSTOM]);
  });

  await t.test('a code whose leftover record is still at the old target is claimed and moved', async (t) => {
    // An earlier `{ shortCode }` PUT landed the record at the page, then its row write failed.
    const { created, upserts, linkRows } = setup(t, {
      ids: { 'site-c': { id: 'site-c', url: PAGE, createdBy: 'push' } }
    });

    const res = await setShortLink({ shortCode: 'site-c', url: CUSTOM });

    assert.strictEqual(res.statusCode, 200, 'the same project\'s leftover is not "already in use"');
    assert.deepStrictEqual(created, []);
    assert.strictEqual(upserts[0].shortCode, 'site-c');
    assert.strictEqual(linkRows.get('site-c').url, CUSTOM);
  });

  await t.test('two url PUTs racing leave every record at the target the row ends on', async (t) => {
    const OTHER = 'https://www2.gov.bc.ca/gov/content/site-c-two';
    const { linkRows, state } = setup(t, withLegacy());
    let raced = false;
    const read = async (id) => linkRows.get(id) || null;
    links.getById.mock.mockImplementation(async (id) => {
      const record = await read(id);
      if (!raced) {
        raced = true;
        // B lands whole between A's row write and A's repoint.
        assert.strictEqual((await setUrl(OTHER)).statusCode, 200);
      }
      return record;
    });

    const res = await setUrl(CUSTOM);

    assert.strictEqual(state.row.shortLinkUrl, OTHER, 'the premise: B wrote the row last');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.url, OTHER, 'A answers with where the links really go');
    assert.deepStrictEqual([linkRows.get('nicomen-wind-energy').url, linkRows.get('kq7bt2rm').url],
      [OTHER, OTHER], 'A\'s late repoint does not strand the records at its own url');
  });

  await t.test('a target that keeps moving under the repoint is a 503', async (t) => {
    setup(t, withLegacy());
    let reads = 0;
    const read = projects.getById.mock;
    const first = stored({ legacyShortCodes: ['kq7bt2rm'] });
    read.mockImplementation(async () => (reads++ === 0
      ? structuredClone(first)
      : { ...structuredClone(first), shortLinkUrl: `${CUSTOM}-${reads}` }));

    const res = await setUrl(CUSTOM);

    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(reads, 3, 'one read, then one re-read per pass: two passes, no more');
  });

  await t.test('the public page sent as a url is stored as the default, not pinned', async (t) => {
    const { upserts } = setup(t, withLegacy({ shortLinkUrl: CUSTOM }));

    const res = await setUrl(PAGE);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(upserts[0].shortLinkUrl, null);
    assert.deepStrictEqual([res.body.url, res.body.shortLinkCustom], [PAGE, false]);
  });

  await t.test('url null on a project already at its page writes nothing, and repoints only stale records', async (t) => {
    const quiet = setup(t, withLegacy());
    const res = await setUrl(null);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual([quiet.upserts, quiet.created, links.repoint.mock.callCount()], [[], [], 0]);
    assert.strictEqual(res.body.shortLinkCustom, false);

    t.mock.restoreAll();
    const opts = withLegacy();
    opts.ids.kq7bt2rm.url = 'https://old-host.gov.bc.ca/p/1';
    const stale = setup(t, opts);
    await setUrl(null);
    assert.deepStrictEqual([stale.upserts, links.repoint.mock.calls.map(c => c.arguments[0])], [[], ['kq7bt2rm']]);
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
      body: {
        name: 'Nicomen Wind Energy Phase Two', shortCode: 'other', legacyShortCodes: [],
        shortLinkUrl: CUSTOM
      }
    }, mockRes());

    assert.strictEqual(upserts[0].name, 'Nicomen Wind Energy Phase Two');
    assert.strictEqual(upserts[0].shortCode, 'nicomen-wind-energy',
      'a code with no link record behind it would be a dead print');
    assert.ok(!('shortLinkUrl' in upserts[0]), 'the target moves only with its records');
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

  await t.test('a POST racing a short-code PUT keeps the target the PUT stored', async (t) => {
    const writes = [];
    const { state } = setup(t, {
      upsert: async (row, opts, state) => {
        writes.push(opts);
        if (writes.length === 1) {
          // The PUT lands between the POST's read and its write.
          state.row = { ...state.row, shortLinkUrl: CUSTOM, _etag: '"0x2"' };
          throw lostRace();
        }
        if (opts.etag !== state.row._etag) throw lostRace();
        state.row = row;
        return row;
      }
    });

    const res = mockRes();
    await projectController.createProject({
      params: {}, query: {}, user: STAFF,
      body: { trackProjectId: 207, name: 'Nicomen Wind Energy', centroid: { coordinates: [-121.4, 50.2] } }
    }, res);

    assert.strictEqual(res.statusCode, 201);
    assert.deepStrictEqual(writes, [{ etag: '"0x1"' }, { etag: '"0x2"' }]);
    assert.strictEqual(state.row.shortLinkUrl, CUSTOM);
  });

  await t.test('a POST under a new id is a create, which a row made behind it refuses', async (t) => {
    const writes = [];
    setup(t, {
      project: null,
      upsert: async (row, opts) => { writes.push(opts); throw conflict(); }
    });

    const res = mockRes();
    await projectController.createProject({
      params: {}, query: {}, user: STAFF,
      body: { trackProjectId: 208, name: 'Kemess', centroid: { coordinates: [-121.4, 50.2] } }
    }, res);

    assert.deepStrictEqual(writes, [{ create: true }, { create: true }, { create: true }]);
    assert.strictEqual(res.statusCode, 503);
  });

  await t.test('GET /projects/:id carries the legacy codes to everyone', async (t) => {
    setup(t, { project: stored({ legacyShortCodes: ['kq7bt2rm'] }) });
    const res = mockRes();

    await projectController.getProject({ params: { id: '207' }, query: {} }, res);

    assert.deepStrictEqual(res.body.legacyShortCodes, ['kq7bt2rm']);
    assert.strictEqual(res.body.shortUrl, `${config.linkBaseUrl}/s/nicomen-wind-energy`);
  });

  await t.test('GET /projects/:id carries the effective target wherever it carries shortUrl', async (t) => {
    const read = async (project, user) => {
      t.mock.restoreAll();
      setup(t, { project });
      const res = mockRes();
      await projectController.getProject({ params: { id: '207' }, query: {}, user }, res);
      return res.body;
    };

    const pick = (body) => [body.shortLinkUrl, body.shortLinkCustom];
    assert.deepStrictEqual(pick(await read(stored({ shortLinkUrl: CUSTOM }))), [CUSTOM, true]);
    assert.deepStrictEqual(pick(await read(stored({ shortLinkUrl: CUSTOM }), STAFF)), [CUSTOM, true]);
    assert.deepStrictEqual(pick(await read(stored())), [PAGE, false], 'no target set is the public page');
    const noCode = await read(stored({ shortCode: undefined, shortLinkUrl: CUSTOM }));
    assert.ok(!('shortUrl' in noCode) && !('shortLinkUrl' in noCode) && !('shortLinkCustom' in noCode));
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
