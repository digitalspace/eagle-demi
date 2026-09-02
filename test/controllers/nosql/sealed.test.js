'use strict';

/**
 * The sealed compartment — `/api/sealed` (docs/rbac-architecture.md §1, "Level 0").
 *
 * Three things are worth pinning and none of them is the happy path: that the ladder cannot see a
 * sealed row however privileged it is, that the compartment's own chain admits `compliance` and
 * nothing else, and that every route writes an audit row — READS INCLUDED, which is true nowhere
 * else in DEMI.
 */

process.env.NODE_ENV = 'test';
// Before src/config is first required: the audit writer is inert without the DCR pair, so the
// assertions below would otherwise pass by recording nothing. A batch of 1 flushes synchronously.
process.env.AUDIT_DCR_ENDPOINT = 'https://dcr-test.canadacentral-1.ingest.monitor.azure.com';
process.env.AUDIT_DCR_IMMUTABLE_ID = 'dcr-testimmutableid';
process.env.AUDIT_MAX_BATCH = '1';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const audit = require('../../../src/utils/audit');
const config = require('../../../src/config');
const cosmos = require('../../../src/db/cosmos-nosql');
const documents = require('../../../src/repositories/documents');
const projects = require('../../../src/repositories/projects');
const chunksRepo = require('../../../src/repositories/chunks');
const storage = require('../../../src/storage');
const aiSearch = require('../../../src/search/ai-search');
const sealedController = require('../../../src/controllers/nosql/sealed');
const documentController = require('../../../src/controllers/nosql/document');
const searchController = require('../../../src/controllers/search');
const routes = require('../../../src/http/routes');
const { readForLevel } = require('../../../src/helpers/access-sql');
const { code } = require('../../helpers/router-source');

const SCRIPTS_DIR = path.join(__dirname, '..', '..', '..', 'src', 'scripts');

const COMPLIANCE = {
  sub: 'kc-sub-c', preferred_username: 'ce.officer', realm_access: { roles: ['compliance'] }
};
const SYSADMIN = {
  sub: 'kc-sub-1', preferred_username: 'sys.admin', realm_access: { roles: ['sysadmin'] }
};

const SEALED_ROW = {
  id: 's1', projectId: '207', displayName: 'Warrant.pdf', s3Key: '207/warrant.pdf',
  read: ['compliance'], sealedAt: '2026-09-01T00:00:00.000Z', isPublished: false
};
const PUBLIC_ROW = {
  id: 'd1', projectId: '207', displayName: 'Application.pdf', s3Key: '207/app.pdf',
  read: ['staff', 'idir', 'public'], isPublished: true
};

/** The five routes, named the way the router declares them. */
const SEALED_ROUTES = [
  ['post', '/sealed'],
  ['get', '/sealed'],
  ['get', '/sealed/:id'],
  ['get', '/sealed/:id/download'],
  ['post', '/sealed/:id/release']
];

let rows = [];
// Tagged with the stream: the ladder routes emit a `search` ANALYTICS row through the same
// transport, and "no audit row was written" is the assertion the compartment turns on.
audit._setTransport(async (stream, batch) => { rows.push(...batch.map(row => ({ ...row, stream }))); });

const auditRows = () => rows.filter(row => row.stream === audit.AUDIT_STREAM);

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code_) { this.statusCode = code_; return this; },
    json(data) { this.body = data; return this; },
    setHeader(name, value) { this.headers[name] = value; }
  };
}

const routeFor = (method, routePath) =>
  routes.find(r => r.method === method && r.path === routePath);

/**
 * Run a route's guard chain. Both sealed guards answer synchronously on the credentials used here
 * (the test X-Api-Key and a decoded Bearer), so a callback loop is the whole runner.
 *
 * @returns {boolean} true when every guard called next()
 */
function runGuards(guards, req, res) {
  for (const guard of guards) {
    let advanced = false;
    guard(req, res, () => { advanced = true; });
    if (!advanced) return false;
  }
  return true;
}

/** A request carrying the test suite's sysadmin API key. */
const sysadminReq = () => ({
  header: (name) => (name === 'X-Api-Key' ? 'eagle-demi-api-key' : null),
  params: { id: 's1' }, query: {}, body: {}
});

/** A request carrying a Keycloak token — the payload comes from the mocked `jwt.decode`. */
const bearerReq = () => ({
  header: (name) => (name === 'Authorization' ? 'Bearer compliance-token' : null),
  params: { id: 's1' }, query: {}, body: {}
});

/**
 * A fake Cosmos honouring TWO things: the sealed exclusion and an `@id` criterion. Everything the
 * emitted SQL does not exclude comes back — so dropping the exclusion from `readClause` hands the
 * sealed row straight to the assertion below instead of quietly passing. The id is honoured because
 * a point read that ignored it would answer with the first row of the container.
 */
const fakeCosmosQuery = (stored) => async (_container, spec) => {
  const visible = /NOT ARRAY_CONTAINS\(c\.read, 'compliance'\)/.test(spec.query)
    ? stored.filter(row => !(row.read || []).includes('compliance'))
    : stored;
  const id = (spec.parameters || []).find(param => param.name === '@id');
  return { items: id ? visible.filter(row => row.id === id.value) : visible };
};

/** The same idea for AI Search: the OData twin of the clause above. */
const fakeIndex = (stored) => async ({ filter }) => {
  const items = /not read\/any\(r: r eq 'compliance'\)/.test(filter || '')
    ? stored.filter(row => !(row.read || []).includes('compliance'))
    : stored;
  return { items, count: items.length };
};

/** Everything the release path writes to besides Cosmos. */
function stubCascade(t) {
  t.mock.method(aiSearch, 'indexes', () => ({
    chunks: 'chunks', projects: 'projects', documents: 'documents'
  }));
  t.mock.method(aiSearch, 'writeAcls', async () => 1);
  t.mock.method(chunksRepo, 'setAclForDocument', async () => ({ succeeded: 0, failed: 0 }));
}

test('the sealed compartment routes', async (t) => {
  t.beforeEach(() => { rows = []; });
  t.afterEach(() => t.mock.restoreAll());
  t.after(() => audit._resetTransport());

  await t.test('sysadmin gets 403 on every sealed route', async () => {
    for (const [method, routePath] of SEALED_ROUTES) {
      const route = routeFor(method, routePath);
      assert.ok(route, `${method.toUpperCase()} ${routePath} is not in the route table`);

      const res = mockRes();
      const admitted = runGuards(route.guards, sysadminReq(), res);

      assert.strictEqual(admitted, false,
        `${method.toUpperCase()} ${routePath} admitted a sysadmin into the compartment`);
      assert.strictEqual(res.statusCode, 403);
      assert.match(res.body.error, /compliance/);
    }
  });

  await t.test('a compliance-only token reaches the sealed routes and nothing else', async () => {
    config.keycloakEnabled = false;
    t.mock.method(jwt, 'decode', () => COMPLIANCE);

    for (const [method, routePath] of SEALED_ROUTES) {
      const req = bearerReq();
      const res = mockRes();
      const admitted = runGuards(routeFor(method, routePath).guards, req, res);

      assert.ok(admitted, `${method.toUpperCase()} ${routePath} refused a compliance holder`);
      assert.deepStrictEqual(req.user.realm_access.roles, ['compliance']);
    }

    // "Nothing else": every other write route is behind authMiddleware, whose AUTHENTICATED_ROLES
    // excludes `compliance` — so the compartment's holder is not a staff member with extra reach.
    const res = mockRes();
    const admitted = runGuards(routeFor('post', '/documents').guards, bearerReq(), res);

    assert.strictEqual(admitted, false, 'a compliance token reached POST /documents');
    assert.strictEqual(res.statusCode, 403);
  });

  // The ladder routes, for BOTH the caller that never held `compliance` and the one that does. The
  // holder is the interesting case: it may read the row at `/api/sealed/:id`, and the compartment's
  // whole mechanism is that it cannot read it anywhere the read goes unaudited.
  for (const caller of [SYSADMIN, COMPLIANCE]) {
    const who = caller.realm_access.roles[0];

    await t.test(`a sealed row is never returned to the ladder (${who})`, async () => {
      // Driven through the REAL repository and controllers, so the emitted SQL is what decides.
      t.mock.method(cosmos, 'query', fakeCosmosQuery([PUBLIC_ROW, SEALED_ROW]));

      const listed = mockRes();
      await documentController.getDocuments(
        { query: {}, params: {}, user: caller, headers: {} }, listed);

      assert.deepStrictEqual(listed.body.map(d => d.id), ['d1'],
        `the document list handed a sealed row to ${who}`);

      // GET /api/documents/:id — the point read, which bypasses the list predicate entirely.
      const fetched = mockRes();
      await documentController.getDocument(
        { query: {}, params: { id: 's1' }, user: caller, headers: {} }, fetched);

      assert.strictEqual(fetched.statusCode, 404, `getDocument answered ${who} with a sealed row`);

      // GET /api/documents/:id/download — the ordinary download route, same exclusion, no second
      // door onto the bytes.
      t.mock.method(storage, 'getDownloadUrl',
        async () => assert.fail(`downloadDocument presigned a sealed row for ${who}`));
      const downloaded = mockRes();
      await documentController.downloadDocument(
        { query: {}, params: { id: 's1' }, user: caller, headers: {} }, downloaded);

      assert.strictEqual(downloaded.statusCode, 404,
        `downloadDocument answered ${who} with a sealed row`);

      // GET /api/search, same row present in the index.
      t.mock.method(aiSearch, 'searchDocuments', fakeIndex([PUBLIC_ROW, SEALED_ROW]));
      t.mock.method(projects, 'listByIds', async () => [{ id: '207', name: 'Skeena LNG' }]);

      const searched = mockRes();
      await searchController.search({
        query: { dataset: 'Document', pageSize: '10' }, params: {}, user: caller,
        header: () => null
      }, searched);

      assert.deepStrictEqual(searched.body[0].searchResults.map(r => r._id), ['d1'],
        `document search handed a sealed row to ${who}`);

      await audit.flush();
      assert.deepStrictEqual(auditRows(), [],
        'a ladder read of a sealed row would be an unaudited one');
    });
  }

  await t.test('the compartment route reads the row the ladder refused', async () => {
    // The other half of the invariant: refusing the holder everywhere would seal the record shut.
    t.mock.method(cosmos, 'query', fakeCosmosQuery([PUBLIC_ROW, SEALED_ROW]));

    const res = mockRes();
    await sealedController.getSealed(
      { params: { id: 's1' }, query: {}, user: COMPLIANCE }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.id, 's1');

    await audit.flush();
    assert.strictEqual(auditRows().length, 1, 'and it is audited');
    assert.strictEqual(auditRows()[0].Action, 'sealed.read');
  });

  await t.test('the compartment route downloads the row the ladder refused', async () => {
    t.mock.method(cosmos, 'query', fakeCosmosQuery([PUBLIC_ROW, SEALED_ROW]));
    t.mock.method(storage, 'getDownloadUrl', async (key, opts) => {
      assert.strictEqual(key, SEALED_ROW.s3Key);
      assert.strictEqual(opts.fileName, 'warrant.pdf');
      return 'https://presigned.example/warrant.pdf';
    });

    const res = mockRes();
    await sealedController.downloadSealed(
      { params: { id: 's1' }, query: {}, user: COMPLIANCE }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.url, 'https://presigned.example/warrant.pdf');
    assert.strictEqual(res.body.fileName, 'warrant.pdf');
    assert.strictEqual(res.body.displayName, SEALED_ROW.displayName);

    await audit.flush();
    assert.strictEqual(auditRows().length, 1, 'a sealed download is audited too');
    assert.strictEqual(auditRows()[0].Action, 'sealed.download');
    assert.strictEqual(auditRows()[0].TargetId, 's1');
  });

  await t.test('a public row is not the download route\'s to serve', async () => {
    t.mock.method(cosmos, 'query', fakeCosmosQuery([PUBLIC_ROW, SEALED_ROW]));
    t.mock.method(storage, 'getDownloadUrl',
      async () => assert.fail('a row outside the compartment must never be presigned here'));

    const res = mockRes();
    await sealedController.downloadSealed(
      { params: { id: 'd1' }, query: {}, user: COMPLIANCE }, res);

    assert.strictEqual(res.statusCode, 404);

    await audit.flush();
    assert.deepStrictEqual(auditRows(), [], 'a refused download is not an act');
  });

  await t.test('release lands at level 1', async () => {
    let saved;
    t.mock.method(documents, 'getById', async () => ({ ...SEALED_ROW }));
    // The repository derives the ACL from the level it is given, so this records what the release
    // asked for rather than what the test assumed.
    t.mock.method(documents, 'setPublished', async (id, projectId, level) => {
      saved = { id, projectId, read: readForLevel(level) };
      return { ...SEALED_ROW, ...saved, isPublished: false };
    });
    stubCascade(t);

    const res = mockRes();
    await sealedController.releaseSealed({
      params: { id: 's1' }, query: {},
      body: { caseNumber: 'CE-2026-014', decision: 'released to the project team' },
      user: COMPLIANCE
    }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(saved.read, ['team']);
  });

  await t.test('seal writes the record at level 0', async () => {
    let saved;
    t.mock.method(projects, 'getById', async () => ({ id: '207', read: ['staff'] }));
    t.mock.method(documents, 'upsert', async (item) => { saved = item; return item; });

    const res = mockRes();
    await sealedController.createSealed({
      params: {}, query: {}, user: COMPLIANCE,
      body: { project: '207', displayName: 'Warrant.pdf', s3Key: '207/warrant.pdf' }
    }, res);

    assert.strictEqual(res.statusCode, 201);
    assert.deepStrictEqual(saved.read, ['compliance']);
    assert.strictEqual(saved.isPublished, false);
    assert.ok(saved.sealedAt, 'a sealed row records when it was sealed');
  });

  await t.test('a row that is not sealed is not the compartment\'s to read or release', async () => {
    // Without this guard a compliance holder could pull any public document down to level 1.
    t.mock.method(documents, 'getById', async () => ({ ...PUBLIC_ROW }));
    let released = false;
    t.mock.method(documents, 'setPublished', async () => { released = true; return PUBLIC_ROW; });
    stubCascade(t);

    const read = mockRes();
    await sealedController.getSealed({ params: { id: 'd1' }, query: {}, user: COMPLIANCE }, read);
    assert.strictEqual(read.statusCode, 404);

    const release = mockRes();
    await sealedController.releaseSealed({
      params: { id: 'd1' }, query: {},
      body: { caseNumber: 'CE-2026-014', decision: 'released' }, user: COMPLIANCE
    }, release);
    assert.strictEqual(release.statusCode, 404);
    assert.strictEqual(released, false, 'a public row is never rewritten by the release route');
  });

  await t.test('release without a caseNumber is 400', async () => {
    t.mock.method(documents, 'setPublished',
      async () => assert.fail('a refused release must not write'));

    const res = mockRes();
    await sealedController.releaseSealed({
      params: { id: 's1' }, query: {}, body: { decision: 'released' }, user: COMPLIANCE
    }, res);

    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /caseNumber/);
    assert.strictEqual(rows.length, 0, 'a refused release is not an act');
  });

  await t.test('release without a decision is 400', async () => {
    t.mock.method(documents, 'setPublished',
      async () => assert.fail('a refused release must not write'));

    const res = mockRes();
    // Whitespace, not absence: an empty decision is the same non-answer as none at all.
    await sealedController.releaseSealed({
      params: { id: 's1' }, query: {}, body: { caseNumber: 'CE-2026-014', decision: '  ' },
      user: COMPLIANCE
    }, res);

    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /decision/);
    assert.strictEqual(rows.length, 0);
  });

  await t.test('every sealed route audits, reads included', async () => {
    t.mock.method(projects, 'getById', async () => ({ id: '207', read: ['staff'] }));
    t.mock.method(documents, 'upsert', async (item) => item);
    t.mock.method(documents, 'listSealed', async () => ({ items: [{ ...SEALED_ROW }] }));
    t.mock.method(documents, 'getById', async () => ({ ...SEALED_ROW }));
    t.mock.method(documents, 'setPublished', async () => ({ ...SEALED_ROW, read: ['team'] }));
    stubCascade(t);

    const base = { params: { id: 's1' }, query: {}, user: COMPLIANCE };
    const calls = [
      ['sealed.create', () => sealedController.createSealed({
        ...base, body: { project: '207', displayName: 'Warrant.pdf', s3Key: '207/warrant.pdf' }
      }, mockRes())],
      ['sealed.list', () => sealedController.listSealed({ ...base }, mockRes())],
      ['sealed.read', () => sealedController.getSealed({ ...base }, mockRes())],
      ['sealed.release', () => sealedController.releaseSealed({
        ...base, body: { caseNumber: 'CE-2026-014', decision: 'released' }
      }, mockRes())]
    ];

    for (const [action, run] of calls) {
      rows = [];
      await run();
      await audit.flush();

      assert.strictEqual(rows.length, 1, `${action} wrote ${rows.length} rows`);
      assert.strictEqual(rows[0].Action, action);
      assert.strictEqual(rows[0].ActorId, 'kc-sub-c');
    }

    // The release row is the one an investigator reads back, so it carries the authority claimed.
    rows = [];
    await sealedController.releaseSealed({
      ...base, body: { caseNumber: 'CE-2026-014', decision: 'released' }
    }, mockRes());
    await audit.flush();

    assert.strictEqual(rows[0].TargetId, 's1');
    assert.strictEqual(rows[0].Detail.caseNumber, 'CE-2026-014');
    assert.strictEqual(rows[0].Detail.decision, 'released');
  });

  await t.test('no script names the sealed role', () => {
    // Condition 2 of the seal (docs/rbac-architecture.md §1): exports and backups stay locked down,
    // so no seed, export or reconcile script may put `compliance` into its access context.
    // `probe-acl.js` is the one exception — it mints keys through the gated admin route to probe
    // the matrix from outside, and builds no access context of its own.
    const scripts = fs.readdirSync(SCRIPTS_DIR)
      .filter(name => name.endsWith('.js') && name !== 'probe-acl.js');

    assert.ok(scripts.length >= 10, `expected the scripts directory, found ${scripts.length}`);

    for (const name of scripts) {
      const body = code(fs.readFileSync(path.join(SCRIPTS_DIR, name), 'utf8'));
      assert.ok(!/compliance/.test(body),
        `src/scripts/${name} names the sealed role — a script must never read the compartment`);
    }
  });
});
