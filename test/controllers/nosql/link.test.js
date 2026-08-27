'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const links = require('../../../src/repositories/links');
const linkController = require('../../../src/controllers/nosql/link');
const config = require('../../../src/config');

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
      ['createdAt', 'createdBy', 'id', 'note', 'shortUrl', 'updatedAt', 'url']);
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
    t.mock.method(links, 'list', async () => [
      { id: 'aaaaaaaa', url: DEST, note: 'poster', createdAt: '2026-08-02T00:00:00.000Z',
        createdBy: 'staff.person', updatedAt: null },
      { id: 'bbbbbbbb', url: DEST, createdAt: '2026-08-01T00:00:00.000Z', createdBy: 'key:eagle-notify' }
    ]);

    const res = mockRes();
    await linkController.listLinks({ query: {}, user: STAFF }, res);

    assert.strictEqual(res.body.length, 2);
    for (const row of res.body) {
      assert.deepStrictEqual(Object.keys(row).sort(),
        ['createdAt', 'createdBy', 'id', 'note', 'shortUrl', 'updatedAt', 'url']);
      assert.strictEqual(row.shortUrl, `${config.linkBaseUrl}/s/${row.id}`);
    }
    assert.strictEqual(res.body[1].note, null, 'a missing note reads as null, not undefined');
  });
});
