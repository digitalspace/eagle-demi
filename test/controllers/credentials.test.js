'use strict';

/**
 * POST /api/credentials, GET /api/credentials, POST /api/credentials/revoke.
 *
 * A grant is access policy, so the two things worth pinning are the gate that decides who may
 * write one and the audit row that says who did. The bulk revoke is here because "exactly that
 * batch" is the assertion an operator relies on when a grant has to be pulled back in a hurry.
 */

process.env.NODE_ENV = 'test';
// Before src/config is first required: the audit writer is inert without these, so the assertions
// below would otherwise pass by recording nothing. A batch of 1 drains through the stub transport
// synchronously, which is what lets "before the response" be observed.
process.env.AUDIT_DCR_ENDPOINT = 'https://dcr-test.canadacentral-1.ingest.monitor.azure.com';
process.env.AUDIT_DCR_IMMUTABLE_ID = 'dcr-testimmutableid';
process.env.AUDIT_MAX_BATCH = '1';

const test = require('node:test');
const assert = require('node:assert');

const audit = require('../../src/utils/audit');
const cosmos = require('../../src/db/cosmos-nosql');
const controller = require('../../src/controllers/nosql/credentials');
const apiRouter = require('../../src/routes/api');

const SYSADMIN = {
  sub: 'kc-sub-1', preferred_username: 'sys.admin', realm_access: { roles: ['sysadmin'] }
};
const STAFF = {
  sub: 'kc-sub-2', preferred_username: 'staff.person', realm_access: { roles: ['staff'] }
};

const IN_A_YEAR = new Date(Date.now() + 365 * 86400000).toISOString();

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    setHeader() {}
  };
}

function stored(id, batchId, partyId) {
  return {
    id,
    party: { type: 'user', id: partyId },
    scope: { type: 'project', ids: ['207'] },
    levels: [2],
    start: new Date(Date.now() - 86400000).toISOString(),
    end: IN_A_YEAR,
    batchId,
    revokedAt: null
  };
}

let rows = [];
audit._setTransport(async (_stream, batch) => { rows.push(...batch); });

async function rowsFrom(fn) {
  rows = [];
  await fn();
  await audit.flush();
  return rows;
}

test('bulk revoke by batchId revokes exactly that batch', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const granted = [
    stored('c1', 'batch-a', 'u1'),
    stored('c2', 'batch-a', 'u2'),
    stored('c3', 'batch-b', 'u3')
  ];

  // Applies the clause the repository sent rather than returning a canned set: a revoke that
  // dropped the batch binding would take all three here and fail the count.
  t.mock.method(cosmos, 'query', async (_container, spec) => {
    const batchId = (spec.parameters.find(p => p.name === '@batchId') || {}).value;
    return {
      items: granted.filter(row =>
        (!/c\.batchId = @batchId/.test(spec.query) || row.batchId === batchId) &&
        (!/IS_NULL\(c\.revokedAt\)/.test(spec.query) || !row.revokedAt))
    };
  });

  const patched = [];
  t.mock.method(cosmos, 'patch', async (_c, id, pk, operations) => {
    patched.push({ id, pk, operations });
    return {};
  });

  const res = mockRes();
  const written = await rowsFrom(() => controller.revokeCredentials(
    { body: { batchId: 'batch-a' }, query: {}, params: {}, user: SYSADMIN }, res));

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.revoked, 2);
  assert.deepStrictEqual(res.body.ids, ['c1', 'c2']);
  assert.deepStrictEqual(patched.map(p => p.id), ['c1', 'c2'], 'batch-b is untouched');
  assert.deepStrictEqual(patched.map(p => p.operations[0].path), ['/revokedAt', '/revokedAt']);

  // One row per credential, plus one summary row for the set.
  assert.strictEqual(written.length, 3);
  assert.deepStrictEqual(written.map(r => r.Action), Array(3).fill('credential.revoke'));
  assert.deepStrictEqual(written.map(r => r.TargetId), ['c1', 'c2', 'batch-a']);
  assert.strictEqual(written[2].TargetType, 'credential-batch');
  assert.strictEqual(written[2].Detail.revoked, 2);
  assert.strictEqual(written[2].Detail.by, 'batchId');
});

test('every grant and revoke audits', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  t.after(() => audit._resetTransport());

  await t.test('a grant writes one credential.grant before the response', async () => {
    t.mock.method(cosmos, 'create', async (_container, item) => item);

    let rowsAtResponse = null;
    const res = mockRes();
    res.json = function (data) {
      rowsAtResponse = rows.slice();
      this.body = data;
      return this;
    };

    const written = await rowsFrom(() => controller.createCredential({
      body: {
        party: { type: 'user', id: 'bceid-sub-1' },
        scope: { type: 'project', ids: ['207'] },
        levels: [1, 2],
        end: IN_A_YEAR,
        note: 'working group'
      },
      query: {}, params: {}, user: SYSADMIN
    }, res));

    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(written.length, 1);
    assert.strictEqual(rowsAtResponse.length, 1, 'the row exists by the time res.json runs');

    const row = written[0];
    assert.strictEqual(row.Action, 'credential.grant');
    assert.strictEqual(row.TargetType, 'credential');
    assert.strictEqual(row.TargetId, res.body.id);
    assert.strictEqual(row.ProjectId, '207');
    assert.strictEqual(row.ActorId, 'kc-sub-1');
    assert.deepStrictEqual(row.Detail.levels, [1, 2]);
    assert.strictEqual(row.Detail.end, IN_A_YEAR);
    assert.strictEqual(row.Detail.batchId, res.body.batchId);
    assert.strictEqual(res.body.grantedBy, 'sys.admin');
    assert.strictEqual(res.body.revokedAt, null);
  });

  await t.test('a single revoke writes one row and no batch summary', async () => {
    t.mock.method(cosmos, 'query', async () => ({ items: [stored('c9', 'batch-a', 'u9')] }));
    t.mock.method(cosmos, 'patch', async () => ({}));

    const written = await rowsFrom(() => controller.revokeCredentials(
      { body: { id: 'c9', cause: 'project-closed' }, query: {}, params: {}, user: SYSADMIN },
      mockRes()));

    assert.strictEqual(written.length, 1, 'no summary row when one credential was named');
    assert.strictEqual(written[0].Action, 'credential.revoke');
    assert.strictEqual(written[0].TargetId, 'c9');
    assert.strictEqual(written[0].Detail.cause, 'project-closed');
  });

  await t.test('a refused grant writes nothing at all', async () => {
    const created = [];
    t.mock.method(cosmos, 'create', async (_c, item) => { created.push(item); return item; });

    const res = mockRes();
    const written = await rowsFrom(() => controller.createCredential({
      body: { party: { type: 'user', id: 'x' }, scope: { type: 'project', ids: ['207'] }, levels: [2] },
      query: {}, params: {}, user: SYSADMIN
    }, res));

    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /end is required/);
    assert.strictEqual(created.length, 0);
    assert.strictEqual(written.length, 0);
  });

  await t.test('a revoke naming no selector, or two, is refused', async () => {
    for (const body of [{}, { id: 'c1', batchId: 'batch-a' }]) {
      const res = mockRes();
      await controller.revokeCredentials({ body, query: {}, params: {}, user: SYSADMIN }, res);
      assert.strictEqual(res.statusCode, 400, `${JSON.stringify(body)} must be refused`);
    }
  });
});

test('the routes mount the sysadmin gate, not requireWrite alone', () => {
  // The handler checks no roles, so a route missing the layer would pass every test above while
  // being reachable by any staff member — or by the machine writer, which could then grant itself
  // sight of anything.
  for (const [path, method] of [['/credentials', 'post'], ['/credentials', 'get'],
    ['/credentials/revoke', 'post']]) {
    const layer = apiRouter.stack.find(
      (l) => l.route && l.route.path === path && l.route.methods[method]);
    assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);

    const names = layer.route.stack.map((h) => h.handle.name);
    assert.strictEqual(names.length, 4, 'authMiddleware, requireWrite, requireRole, handler');
    assert.ok(names.includes('requireWrite'));

    // The third layer is the closure requireRole returns — exercised rather than named, since
    // requireWrite would also sit in an unnamed slot and only a staff token tells them apart.
    const res = mockRes();
    let nexted = false;
    layer.route.stack[2].handle({ user: STAFF }, res, () => { nexted = true; });
    assert.strictEqual(nexted, false, `staff must be refused on ${method.toUpperCase()} ${path}`);
    assert.strictEqual(res.statusCode, 403);
  }
});
