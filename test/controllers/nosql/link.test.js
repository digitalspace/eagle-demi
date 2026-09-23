'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const links = require('../../../src/repositories/links');
const projects = require('../../../src/repositories/projects');
const linkController = require('../../../src/controllers/nosql/link');
const config = require('../../../src/config');
const { logger } = require('../../../src/utils/logger');
const { canRead, readForLevel } = require('../../../src/helpers/access-sql');

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    contentType: undefined,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    send(data) { this.body = data; return this; },
    type(t) { this.contentType = t; return this; },
    set(k, v) { this.headers[k] = v; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    redirect(code, location) {
      this.statusCode = code;
      this.headers.Location = location;
      return this;
    }
  };
}

const STAFF = { preferred_username: 'staff.person' };
/** A caller who reads every level, beside STAFF, who holds no role and reads public rows only. */
const ADMIN = { preferred_username: 'admin.person', realm_access: { roles: ['sysadmin'] } };
/** Project 207 at level 1: staff tooling sees it, a caller with no role does not. */
const HIDDEN_207 = { id: '207', read: readForLevel(1) };
/** `projects.getById` as the repository answers it: null for a row the caller may not read. */
const gatedGetById = (row) => async (access, id) => (id === row.id && canRead(row, access, projects.PARTITION_FIELD) ? row : null);
const DEST = 'https://projects.eao.gov.bc.ca/p/207';

/** `{code: 409}` is what the Cosmos SDK raises for a duplicate id — the only uniqueness check. */
function conflict() {
  return Object.assign(new Error('Entity with the specified id already exists'), { code: 409 });
}

test('short link controller', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('a mint returns the code, the destination and a composed shortUrl', async () => {
    let stored;
    t.mock.method(links, 'create', async (record) => { stored = record; return record; });

    const res = mockRes();
    await linkController.createLink({
      body: { url: DEST, note: 'PUBLIC-131 poster' }, params: {}, query: {}, user: STAFF
    }, res);

    assert.strictEqual(res.statusCode, 201);
    assert.deepStrictEqual(Object.keys(res.body).sort(), ['code', 'shortUrl', 'url']);
    assert.strictEqual(res.body.url, DEST);
    // The API owns the composition so no client builds it from a second copy of the base URL.
    assert.strictEqual(res.body.shortUrl, `${config.linkBaseUrl}/s/${res.body.code}`);
    // 8 characters drawn from the retypable alphabet — no 0/o/1/l/i, no uppercase.
    assert.match(res.body.code, /^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/);
    assert.strictEqual(stored.id, res.body.code);
    assert.strictEqual(stored.createdBy, 'staff.person');
    assert.strictEqual(stored.updatedAt, null);
  });

  await t.test('a rejected destination comes back with the reason it was rejected', async () => {
    // The caller's error and the caller's to fix, so it is echoed rather than flattened to
    // "invalid url" — the admin modal renders this string.
    let created = false;
    t.mock.method(links, 'create', async () => { created = true; return {}; });

    for (const url of ['https://evilgov.bc.ca', 'http://projects.eao.gov.bc.ca', 'not a url']) {
      const res = mockRes();
      await linkController.createLink({ body: { url }, params: {}, query: {}, user: STAFF }, res);
      assert.strictEqual(res.statusCode, 400, url);
      assert.ok(res.body.error && res.body.error.length > 0, url);
    }
    assert.strictEqual(created, false, 'nothing reaches storage once validation fails');

    const res = mockRes();
    await linkController.createLink(
      { body: { url: 'https://evil.example.com' }, params: {}, query: {}, user: STAFF }, res);
    assert.strictEqual(res.body.error, 'url host is not on the allowlist');
  });

  await t.test('200 generated codes all stay inside the retypable alphabet, 8 characters', async () => {
    t.mock.method(links, 'create', async (record) => record);

    for (let i = 0; i < 200; i++) {
      const res = mockRes();
      await linkController.createLink({ body: { url: DEST }, params: {}, query: {}, user: STAFF }, res);
      assert.match(res.body.code, /^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/, res.body.code);
    }
  });

  await t.test('a custom code is stored and returned lowercased', async () => {
    let stored;
    t.mock.method(links, 'create', async (record) => { stored = record; return record; });

    const res = mockRes();
    await linkController.createLink(
      { body: { url: DEST, code: 'Site-C-EAC' }, params: {}, query: {}, user: STAFF }, res);

    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.code, 'site-c-eac');
    assert.strictEqual(stored.id, 'site-c-eac');
  });

  await t.test('an over-long note and a malformed custom code are both 400', async () => {
    let created = false;
    t.mock.method(links, 'create', async () => { created = true; return {}; });

    const long = mockRes();
    await linkController.createLink(
      { body: { url: DEST, note: 'n'.repeat(201) }, params: {}, query: {}, user: STAFF }, long);
    assert.strictEqual(long.statusCode, 400);

    for (const code of ['ab', 'has space', 'has/slash', 'x'.repeat(65)]) {
      const res = mockRes();
      await linkController.createLink(
        { body: { url: DEST, code }, params: {}, query: {}, user: STAFF }, res);
      assert.strictEqual(res.statusCode, 400, code);
    }
    assert.strictEqual(created, false);
  });

  await t.test('a generated code that collides is retried once', async () => {
    const attempts = [];
    t.mock.method(links, 'create', async (record) => {
      attempts.push(record.id);
      if (attempts.length === 1) throw conflict();
      return record;
    });

    const res = mockRes();
    await linkController.createLink({ body: { url: DEST }, params: {}, query: {}, user: STAFF }, res);

    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(attempts.length, 2, 'retried exactly once');
    assert.notStrictEqual(attempts[0], attempts[1], 'the retry uses a fresh code');
    assert.strictEqual(res.body.code, attempts[1]);
  });

  await t.test('a taken custom code is 409 to the caller, never retried', async () => {
    const attempts = [];
    t.mock.method(links, 'create', async (record) => {
      attempts.push(record.id);
      throw conflict();
    });

    const res = mockRes();
    await linkController.createLink(
      { body: { url: DEST, code: 'skeena-poster' }, params: {}, query: {}, user: STAFF }, res);

    assert.strictEqual(res.statusCode, 409);
    assert.deepStrictEqual(res.body, { error: 'Code already in use' });
    assert.deepStrictEqual(attempts, ['skeena-poster'], 'a vanity code is never silently swapped');
  });

  await t.test('an unconfigured container is a 500 that echoes no driver detail', async () => {
    // repositories/links.create throws rather than returning null, so an unstored link can never
    // answer 201. What must not happen is the Cosmos message reaching the caller.
    t.mock.method(links, 'create', async () => {
      throw new Error('links container not configured');
    });

    const res = mockRes();
    await linkController.createLink({ body: { url: DEST }, params: {}, query: {}, user: STAFF }, res);

    assert.strictEqual(res.statusCode, 500);
    assert.deepStrictEqual(res.body, { success: false, error: 'Internal server error.' });
  });

  await t.test('a repoint returns the whole record and audits nothing on a miss', async () => {
    t.mock.method(links, 'getById', async () => ({
      id: 'abc12345', url: 'https://projects.eao.gov.bc.ca/p/1', note: 'poster',
      createdAt: '2026-08-01T00:00:00.000Z', createdBy: 'staff.person', updatedAt: null
    }));
    t.mock.method(links, 'repoint', async (code, url) => ({
      id: code, url, note: 'poster', createdAt: '2026-08-01T00:00:00.000Z',
      createdBy: 'staff.person', updatedAt: '2026-08-27T00:00:00.000Z'
    }));

    const res = mockRes();
    await linkController.updateLink(
      { params: { code: 'abc12345' }, body: { url: DEST }, query: {}, user: STAFF }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(Object.keys(res.body).sort(),
      ['createdAt', 'createdBy', 'id', 'note', 'personal', 'shortUrl', 'updatedAt', 'url']);
    assert.strictEqual(res.body.url, DEST);
    assert.strictEqual(res.body.shortUrl, `${config.linkBaseUrl}/s/abc12345`);

    const bad = mockRes();
    await linkController.updateLink(
      { params: { code: 'abc12345' }, body: { url: 'https://evil.example.com' }, query: {}, user: STAFF },
      bad);
    assert.strictEqual(bad.statusCode, 400);
  });

  await t.test('an uppercase code repoints the lowercased stored code', async () => {
    let read, written;
    t.mock.method(links, 'getById', async (code) => {
      read = code;
      return { id: 'site-c-eac', url: 'https://projects.eao.gov.bc.ca/p/1' };
    });
    t.mock.method(links, 'repoint', async (code, url) => {
      written = code;
      return { id: code, url, createdAt: '2026-08-01T00:00:00.000Z', createdBy: 'staff.person',
        updatedAt: '2026-08-27T00:00:00.000Z' };
    });

    const res = mockRes();
    await linkController.updateLink(
      { params: { code: 'SITE-C-EAC' }, body: { url: DEST }, query: {}, user: STAFF }, res);

    assert.strictEqual(read, 'site-c-eac');
    assert.strictEqual(written, 'site-c-eac');
    assert.strictEqual(res.statusCode, 200);
  });

  await t.test('a repoint of a code that is not there is 404', async () => {
    t.mock.method(links, 'getById', async () => null);
    let repointed = false;
    t.mock.method(links, 'repoint', async () => { repointed = true; return null; });

    const res = mockRes();
    await linkController.updateLink(
      { params: { code: 'nosuch' }, body: { url: DEST }, query: {}, user: STAFF }, res);

    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(res.body, { error: 'Short link not found' });
    assert.strictEqual(repointed, false);
  });

  await t.test('a delete of a code that is not there is 404', async () => {
    t.mock.method(links, 'getById', async () => null);
    t.mock.method(links, 'remove', async () => false);

    const res = mockRes();
    await linkController.deleteLink({ params: { code: 'nosuch' }, query: {}, user: STAFF }, res);

    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(res.body, { error: 'Short link not found' });
  });

  await t.test('a project\'s code, current or legacy, cannot be repointed or deleted', async () => {
    const owners = { 'site-c': ['207'], kq7bt2rm: ['207'] };
    t.mock.method(projects, 'listShortCodeOwners', async (code) => owners[code] || []);
    t.mock.method(projects, 'getById', gatedGetById(HIDDEN_207));
    t.mock.method(links, 'getById', async (code) => ({ id: code, url: DEST, note: null }));
    const repoint = t.mock.method(links, 'repoint', async () => ({ id: 'x', url: DEST }));
    const remove = t.mock.method(links, 'remove', async () => true);

    const moved = mockRes();
    await linkController.updateLink(
      { params: { code: 'SITE-C' }, query: {}, user: ADMIN, body: { url: DEST } }, moved);
    const deleted = mockRes();
    await linkController.deleteLink({ params: { code: 'kq7bt2rm' }, query: {}, user: ADMIN }, deleted);

    assert.strictEqual(moved.statusCode, 409);
    assert.strictEqual(deleted.statusCode, 409);
    assert.match(deleted.body.error, /belongs to a project/);
    // The admin UI routes the edit to this project instead.
    assert.strictEqual(moved.body.projectId, '207');
    assert.strictEqual(deleted.body.projectId, '207');
    assert.strictEqual(repoint.mock.callCount() + remove.mock.callCount(), 0,
      'a printed project link must never break');
  });

  await t.test('a custom code a project holds cannot be minted over it', async () => {
    t.mock.method(projects, 'listShortCodeOwners', async (code) => (code === 'kq7bt2rm' ? ['207'] : []));
    t.mock.method(projects, 'getById', gatedGetById(HIDDEN_207));
    const create = t.mock.method(links, 'create', async (record) => record);

    const res = mockRes();
    await linkController.createLink(
      { body: { url: DEST, code: 'KQ7BT2RM' }, params: {}, query: {}, user: ADMIN }, res);

    assert.strictEqual(res.statusCode, 409);
    assert.match(res.body.error, /belongs to a project/);
    assert.strictEqual(res.body.projectId, '207');
    assert.strictEqual(create.mock.callCount(), 0);
  });

  await t.test('a project code the caller cannot read is still a 409, without the project id', async () => {
    t.mock.method(projects, 'listShortCodeOwners', async () => ['207']);
    t.mock.method(projects, 'getById', gatedGetById(HIDDEN_207));
    t.mock.method(links, 'getById', async (code) => ({ id: code, url: DEST, note: null }));
    const create = t.mock.method(links, 'create', async (record) => record);
    const repoint = t.mock.method(links, 'repoint', async () => ({ id: 'x', url: DEST }));
    const remove = t.mock.method(links, 'remove', async () => true);

    const minted = mockRes();
    await linkController.createLink(
      { body: { url: DEST, code: 'site-c' }, params: {}, query: {}, user: STAFF }, minted);
    const moved = mockRes();
    await linkController.updateLink(
      { params: { code: 'site-c' }, query: {}, user: STAFF, body: { url: DEST } }, moved);
    const deleted = mockRes();
    await linkController.deleteLink({ params: { code: 'site-c' }, query: {}, user: STAFF }, deleted);

    for (const res of [minted, moved, deleted]) {
      assert.strictEqual(res.statusCode, 409, 'ownership is judged on every project');
      assert.deepStrictEqual(Object.keys(res.body), ['error'], 'a hidden project is not named');
    }
    assert.strictEqual(create.mock.callCount() + repoint.mock.callCount() + remove.mock.callCount(), 0);
  });

  await t.test('the project named is the Track row over its Eagle-only twin, current over legacy', async () => {
    const rows = {
      // The twin a relink leaves behind still holds the code as current.
      'eagle-58851172': { id: 'eagle-58851172', shortCode: 'site-c', read: readForLevel(1) },
      208: { id: '208', shortCode: 'kemess', legacyShortCodes: ['site-c'], read: readForLevel(1) },
      207: { id: '207', shortCode: 'site-c', read: readForLevel(1) }
    };
    t.mock.method(projects, 'listShortCodeOwners', async () => ['eagle-58851172', '208', '207']);
    t.mock.method(projects, 'getById', async (access, id) =>
      (rows[id] && canRead(rows[id], access, projects.PARTITION_FIELD) ? rows[id] : null));

    const res = mockRes();
    await linkController.deleteLink({ params: { code: 'site-c' }, query: {}, user: ADMIN }, res);

    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.projectId, '207');
  });

  await t.test('the project named is the first holder the caller may read', async () => {
    const rows = {
      207: { id: '207', shortCode: 'site-c', read: readForLevel(1) },
      208: { id: '208', legacyShortCodes: ['site-c'], read: readForLevel(4) }
    };
    t.mock.method(projects, 'listShortCodeOwners', async () => ['207', '208']);
    t.mock.method(projects, 'getById', async (access, id) =>
      (rows[id] && canRead(rows[id], access, projects.PARTITION_FIELD) ? rows[id] : null));

    const staff = mockRes();
    await linkController.deleteLink({ params: { code: 'site-c' }, query: {}, user: STAFF }, staff);
    const admin = mockRes();
    await linkController.deleteLink({ params: { code: 'site-c' }, query: {}, user: ADMIN }, admin);

    assert.deepStrictEqual(staff.body, { error: 'This code belongs to a project. Edit it on the project instead.', projectId: '208' });
    assert.strictEqual(admin.body.projectId, '207');
  });

  await t.test('a record a project adopts between the holder check and the write is left whole', async () => {
    let adopter = '207';
    let holders = [];
    t.mock.method(projects, 'listShortCodeOwners', async () => holders);
    t.mock.method(projects, 'getById', gatedGetById(HIDDEN_207));
    t.mock.method(links, 'getById', async (code) => ({ id: code, url: DEST, note: null, _etag: '"a"' }));
    // The adoption lands after the read, so the stored revision is no longer "a".
    const guarded = async (etag) => {
      holders = adopter ? [adopter] : [];
      if (etag !== '"b"') throw Object.assign(new Error('Precondition failed'), { code: 412 });
      return true;
    };
    const repoint = t.mock.method(links, 'repoint', async (_code, _url, { etag } = {}) => guarded(etag));
    const remove = t.mock.method(links, 'remove', async (_code, { etag } = {}) => guarded(etag));

    const moved = mockRes();
    await linkController.updateLink({ params: { code: 'site-c' }, query: {}, user: ADMIN, body: { url: DEST } }, moved);
    holders = [];
    const deleted = mockRes();
    await linkController.deleteLink({ params: { code: 'site-c' }, query: {}, user: ADMIN }, deleted);

    assert.deepStrictEqual(repoint.mock.calls[0].arguments[2], { etag: '"a"' });
    assert.deepStrictEqual(remove.mock.calls[0].arguments[1], { etag: '"a"' });
    for (const res of [moved, deleted]) {
      assert.strictEqual(res.statusCode, 409);
      assert.strictEqual(res.body.projectId, '207', 'the edit is sent to the project that took the code');
    }

    adopter = null;
    holders = [];
    const raced = mockRes();
    await linkController.deleteLink({ params: { code: 'site-c' }, query: {}, user: ADMIN }, raced);
    assert.strictEqual(raced.statusCode, 409);
    assert.match(raced.body.error, /changed while saving/);
  });

  await t.test('a delete that lands answers a message', async () => {
    t.mock.method(links, 'getById', async () => ({ id: 'abc12345', url: DEST, note: null }));
    t.mock.method(links, 'remove', async () => true);

    const res = mockRes();
    await linkController.deleteLink({ params: { code: 'abc12345' }, query: {}, user: STAFF }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { message: 'Short link deleted' });
  });

  await t.test('an uppercase code deletes the lowercased stored code', async () => {
    let read, removed;
    t.mock.method(links, 'getById', async (code) => {
      read = code;
      return { id: 'site-c-eac', url: DEST, note: null };
    });
    t.mock.method(links, 'remove', async (code) => { removed = code; return true; });

    const res = mockRes();
    await linkController.deleteLink({ params: { code: 'SITE-C-EAC' }, query: {}, user: STAFF }, res);

    assert.strictEqual(read, 'site-c-eac');
    assert.strictEqual(removed, 'site-c-eac');
    assert.strictEqual(res.statusCode, 200);
  });

  await t.test('a hit redirects 302 with no-store, never 301', async () => {
    // 302 + no-store is what makes a repoint take effect on a printed poster. A cached 301 could
    // never be corrected.
    t.mock.method(links, 'getById', async () => ({ id: 'abc12345', url: DEST }));

    const res = mockRes();
    await linkController.resolveLink({ params: { code: 'abc12345' }, query: {} }, res);

    assert.strictEqual(res.statusCode, 302);
    assert.strictEqual(res.headers.Location, DEST);
    assert.strictEqual(res.headers['Cache-Control'], 'no-store');
  });

  await t.test('an uppercase request code resolves the lowercased stored code', async () => {
    let lookedUp;
    t.mock.method(links, 'getById', async (code) => { lookedUp = code; return { id: 'site-c-eac', url: DEST }; });

    const res = mockRes();
    await linkController.resolveLink({ params: { code: 'SITE-C-EAC' }, query: {} }, res);

    assert.strictEqual(lookedUp, 'site-c-eac');
    assert.strictEqual(res.statusCode, 302);
    assert.strictEqual(res.headers.Location, DEST);
  });

  await t.test('the miss page never echoes the requested code', async () => {
    // helmet runs with contentSecurityPolicy: false, so interpolating req.params.code into the
    // page would be reflected XSS. This assertion fails if anyone makes the page "helpful".
    t.mock.method(links, 'getById', async () => null);

    const res = mockRes();
    await linkController.resolveLink({ params: { code: '<script>x</script>' }, query: {} }, res);

    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.contentType, 'html');
    assert.ok(!res.body.includes('<script>'), 'the requested code reached the response body');
    assert.ok(!res.body.includes('x</script>'));
    assert.ok(res.body.includes('Link not found'));
    assert.ok(res.body.includes(config.linkBaseUrl));
    assert.strictEqual(res.headers['Cache-Control'], 'no-store');
  });

  await t.test('an update with a code that fails CUSTOM_CODE is a 404, never a read', async () => {
    let read = false;
    t.mock.method(links, 'getById', async () => { read = true; return null; });

    const res = mockRes();
    await linkController.updateLink(
      { params: { code: 'a/b' }, body: { url: DEST }, query: {}, user: STAFF }, res);

    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(res.body, { error: 'Short link not found' });
    assert.strictEqual(read, false, 'the malformed code never reaches a read');
  });

  await t.test('a delete with a code that fails CUSTOM_CODE is a 404, never a read', async () => {
    let read = false;
    t.mock.method(links, 'getById', async () => { read = true; return null; });

    const res = mockRes();
    await linkController.deleteLink({ params: { code: 'a/b' }, query: {}, user: STAFF }, res);

    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(res.body, { error: 'Short link not found' });
    assert.strictEqual(read, false, 'the malformed code never reaches a read');
  });

  await t.test('a resolve with a code that fails CUSTOM_CODE is a 404 with no-store, never a read', async () => {
    let read = false;
    t.mock.method(links, 'getById', async () => { read = true; return null; });

    const res = mockRes();
    await linkController.resolveLink({ params: { code: 'a/b' }, query: {} }, res);

    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.headers['Cache-Control'], 'no-store');
    assert.strictEqual(read, false, 'the malformed code never reaches a read');
  });

  await t.test('every listed row carries its shortUrl', async () => {
    t.mock.method(links, 'listProjectCodes', async () => new Map());
    t.mock.method(links, 'list', async () => [
      { id: 'aaaaaaaa', url: DEST, note: 'poster', createdAt: '2026-08-02T00:00:00.000Z',
        createdBy: 'staff.person', updatedAt: null, personal: false },
      { id: 'bbbbbbbb', url: DEST, createdAt: '2026-08-01T00:00:00.000Z', createdBy: 'key:eagle-notify' }
    ]);

    const res = mockRes();
    await linkController.listLinks({ query: {}, user: STAFF }, res);

    assert.strictEqual(res.body.length, 2);
    for (const row of res.body) {
      assert.deepStrictEqual(Object.keys(row).sort(),
        ['createdAt', 'createdBy', 'id', 'note', 'personal', 'shortUrl', 'updatedAt', 'url']);
      assert.strictEqual(row.shortUrl, `${config.linkBaseUrl}/s/${row.id}`);
    }
    assert.strictEqual(res.body[1].note, null, 'a missing note reads as null, not undefined');
    assert.strictEqual(res.body[1].personal, false, 'a row minted before the flag is shared');
  });

  await t.test('a listed row a project holds names the project and its role, others do not', async () => {
    const row = (id) => ({ id, url: DEST, createdAt: '2026-08-01T00:00:00.000Z', createdBy: 'system' });
    t.mock.method(links, 'list', async () => [row('site-c'), row('abcd2345'), row('kq7bt2rm')]);
    const held = t.mock.method(links, 'listProjectCodes', async () => new Map([
      ['site-c', { projectId: '207', projectRole: 'current' }],
      ['kq7bt2rm', { projectId: '207', projectRole: 'legacy' }]
    ]));
    const perCode = t.mock.method(projects, 'listShortCodeOwners', async () => []);

    const res = mockRes();
    await linkController.listLinks({ query: {}, user: STAFF }, res);

    assert.deepStrictEqual(res.body.map(r => [r.id, r.projectId, r.projectRole]), [
      ['site-c', '207', 'current'],
      ['abcd2345', undefined, undefined],
      ['kq7bt2rm', '207', 'legacy']
    ], 'list order kept');
    assert.ok(!('projectId' in res.body[1]) && !('projectRole' in res.body[1]));
    assert.deepStrictEqual([held.mock.callCount(), perCode.mock.callCount()], [1, 0],
      'one owner query per request, not one per row');
  });

  await t.test('a listed row is tagged only with a project the caller may read', async () => {
    t.mock.method(links, 'list', async () => [
      { id: 'site-c', url: DEST, createdAt: '2026-08-01T00:00:00.000Z', createdBy: 'system' }
    ]);
    // The repository's contract: owners the caller's access cannot read are not in the map.
    t.mock.method(links, 'listProjectCodes', async (access) => new Map(
      canRead(HIDDEN_207, access, projects.PARTITION_FIELD)
        ? [['site-c', { projectId: '207', projectRole: 'current' }]] : []));

    const lower = mockRes();
    await linkController.listLinks({ query: {}, user: STAFF }, lower);
    const admin = mockRes();
    await linkController.listLinks({ query: {}, user: ADMIN }, admin);

    assert.ok(!('projectId' in lower.body[0]) && !('projectRole' in lower.body[0]),
      'a lower-level caller gets the row untagged');
    assert.deepStrictEqual([admin.body[0].projectId, admin.body[0].projectRole], ['207', 'current']);
  });

  await t.test('a failed owner lookup lists the rows untagged and warns, not a 500', async () => {
    t.mock.method(links, 'list', async () => [
      { id: 'site-c', url: DEST, createdAt: '2026-08-01T00:00:00.000Z', createdBy: 'system' }
    ]);
    t.mock.method(links, 'listProjectCodes', async () => { throw new Error('projects container down'); });
    const warn = t.mock.method(logger, 'warn', () => {});

    const res = mockRes();
    await linkController.listLinks({ query: {}, user: ADMIN }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.map(r => [r.id, r.projectId]), [['site-c', undefined]]);
    assert.ok(warn.mock.calls.some(c => /listed untagged/.test(c.arguments[0])));
  });

  await t.test('a personal link is stored, audited and presented as personal', async () => {
    let stored;
    t.mock.method(links, 'create', async (record) => { stored = record; return record; });

    const res = mockRes();
    await linkController.createLink(
      { body: { url: DEST, personal: true }, params: {}, query: {}, user: STAFF }, res);

    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(stored.personal, true);

    const shared = mockRes();
    await linkController.createLink({ body: { url: DEST }, params: {}, query: {}, user: STAFF }, shared);
    assert.strictEqual(stored.personal, false, 'omitted means shared, which is the old behaviour');
  });

  await t.test('a non-boolean personal is a 400', async () => {
    let created = false;
    t.mock.method(links, 'create', async () => { created = true; return {}; });

    for (const personal of ['yes', 1, {}, 'true']) {
      const res = mockRes();
      await linkController.createLink(
        { body: { url: DEST, personal }, params: {}, query: {}, user: STAFF }, res);
      assert.strictEqual(res.statusCode, 400, String(personal));
    }
    assert.strictEqual(created, false);
  });

  await t.test('the list query is scoped to the caller, so personal rows stay theirs', async () => {
    // The filter lives in the query; the controller's job is to hand it the caller's username.
    let asked;
    t.mock.method(links, 'list', async (me) => { asked = me; return []; });

    await linkController.listLinks({ query: {}, user: STAFF }, mockRes());
    assert.strictEqual(asked, 'staff.person');

    await linkController.listLinks({ query: {} }, mockRes());
    assert.strictEqual(asked, '', 'no token, no personal rows — never undefined into the query');
  });
});
