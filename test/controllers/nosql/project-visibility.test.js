'use strict';

/**
 * PATCH /api/projects/:id/visibility — the classify endpoint.
 *
 * Two things are worth testing here and neither is the happy path: the gates that decide who may
 * rewrite access policy, and the fact that the write is a PATCH. An upsert would take the copy of
 * the record this caller read and write it back whole, so classifying one field would silently
 * revert every content edit that landed in between — the failure api-keys.touchLastUsed documents.
 */

process.env.NODE_ENV = 'test';
// Before src/config is first required: the audit writer is inert without them, so the ordering
// assertion below would otherwise pass by recording nothing at all. A batch of 1 makes enqueue
// flush through the stub transport synchronously, which is what lets "before" be observed.
process.env.AUDIT_DCR_ENDPOINT = 'https://dcr-test.canadacentral-1.ingest.monitor.azure.com';
process.env.AUDIT_DCR_IMMUTABLE_ID = 'dcr-testimmutableid';
process.env.AUDIT_MAX_BATCH = '1';

const test = require('node:test');
const assert = require('node:assert');

const audit = require('../../../src/utils/audit');
const cosmos = require('../../../src/db/cosmos-nosql');
const projects = require('../../../src/repositories/projects');
const projectController = require('../../../src/controllers/nosql/project');
const { requireRole } = require('../../../src/middleware/require-roles');
const apiRouter = require('../../../src/routes/api');

const SYSADMIN = {
  sub: 'kc-sub-1', preferred_username: 'sys.admin', realm_access: { roles: ['sysadmin'] }
};
const STAFF = {
  sub: 'kc-sub-2', preferred_username: 'staff.person', realm_access: { roles: ['staff'] }
};

const STORED = {
  id: '207', name: 'Skeena LNG', description: 'A project', complianceLead: 'A. Lead',
  read: ['public', 'staff', 'sysadmin'], isPublished: true
};

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    setHeader() {}
  };
}

/** Run the handler as sysadmin against `STORED`, capturing what reached the repository. */
async function classify(t, body, stored = STORED) {
  // First, because the subtests below call this in a loop: mocking an already-mocked method makes
  // the second mock's "original" the first one, and restoreAll then reinstates the mock.
  t.mock.restoreAll();
  t.mock.method(projects, 'getById', async () => ({ ...stored }));
  const calls = { patchVis: [], upsert: [] };
  t.mock.method(projects, 'patchVis', async (id, vis) => {
    calls.patchVis.push({ id, vis });
    return { ...stored, vis: { ...(stored.vis || {}), ...vis } };
  });
  t.mock.method(projects, 'upsert', async (item) => { calls.upsert.push(item); return item; });

  const res = mockRes();
  await projectController.setVisibility(
    { params: { id: '207' }, query: {}, body, user: SYSADMIN }, res);
  return { res, calls };
}

test('403 without sysadmin', async (t) => {
  const run = (user) => {
    const res = mockRes();
    let nexted = false;
    requireRole('sysadmin')({ user }, res, () => { nexted = true; });
    return { res, nexted };
  };

  await t.test('a staff token is refused, and never reaches the controller', () => {
    const { res, nexted } = run(STAFF);
    assert.strictEqual(nexted, false);
    assert.strictEqual(res.statusCode, 403);
    assert.match(res.body.error, /sysadmin/);
  });

  await t.test('a sysadmin token passes', () => {
    const { res, nexted } = run(SYSADMIN);
    assert.strictEqual(nexted, true);
    assert.strictEqual(res.statusCode, 200);
  });

  await t.test('an anonymous caller fails closed rather than throwing', () => {
    const { res, nexted } = run(undefined);
    assert.strictEqual(nexted, false);
    assert.strictEqual(res.statusCode, 403);
  });

  await t.test('and the route really mounts that gate, not just requireWrite', () => {
    // Asserted on the mounted stack because the gate is only real where it is mounted: the
    // handler itself checks no roles, so a route missing this layer would pass every test above
    // while being reachable by any staff member.
    const layer = apiRouter.stack.find(
      (l) => l.route && l.route.path === '/projects/:id/visibility' && l.route.methods.patch);
    assert.ok(layer, 'PATCH /projects/:id/visibility must be mounted');
    const names = layer.route.stack.map((h) => h.handle.name);
    assert.strictEqual(names.length, 4, 'authMiddleware, requireWrite, requireRole, handler');
    assert.ok(names.includes('requireWrite'));

    // The third layer is the anonymous closure requireRole returns. Exercised rather than named:
    // requireWrite would also sit in an unnamed slot, and only a staff token tells them apart.
    const res = mockRes();
    let nexted = false;
    layer.route.stack[2].handle({ user: STAFF }, res, () => { nexted = true; });
    assert.strictEqual(nexted, false, 'staff must be refused by the third layer');
    assert.strictEqual(res.statusCode, 403);
  });
});

test('400 on an uncatalogued field', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  for (const field of ['notAField', 'constructor', '__proto__', 'toString']) {
    // The last three are the interesting ones: they come off Object.prototype, so a truthiness
    // check reads them as catalogued and their undefined `maxVis` then caps nothing.
    const { res, calls } = await classify(t, { vis: { [field]: 2 } });
    assert.strictEqual(res.statusCode, 400, `${field} is not a catalogued field`);
    assert.match(res.body.error, /catalogued/);
    assert.strictEqual(calls.patchVis.length, 0, 'nothing may be written on a refused body');
  }
});

test('400 on a level above maxVis', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('read is maxVis 0, so a dial of 1 is refused', async () => {
    const { res, calls } = await classify(t, { vis: { read: 1 } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /read/);
    assert.strictEqual(calls.patchVis.length, 0);
  });

  await t.test('name is maxVis 4, so a dial of 4 is accepted', async () => {
    const { res, calls } = await classify(t, { vis: { name: 4 } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(calls.patchVis[0].vis, { name: 4 });
  });

  await t.test('and 0 — never visible — is a real level, not a refusal', async () => {
    const { res } = await classify(t, { vis: { name: 0 } });
    assert.strictEqual(res.statusCode, 200);
  });

  await t.test('a non-integer level is refused, whatever it looks like', async () => {
    for (const level of [2.5, '2', true, [2], { level: 2 }, NaN, -1, 5]) {
      const { res, calls } = await classify(t, { vis: { name: level } });
      assert.strictEqual(res.statusCode, 400, `level ${JSON.stringify(level)} must be refused`);
      assert.strictEqual(calls.patchVis.length, 0);
    }
  });

  await t.test('a body with no vis object at all is refused', async () => {
    for (const body of [{}, { vis: null }, { vis: {} }, { vis: [] }, { vis: 'name' }]) {
      const { res, calls } = await classify(t, body);
      assert.strictEqual(res.statusCode, 400, `${JSON.stringify(body)} must be refused`);
      assert.strictEqual(calls.patchVis.length, 0);
    }
  });
});

test('400 on more than 10 keys', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  // Real catalogued fields, all maxVis 4, so the only thing that can refuse them is the count.
  const FIELDS = ['name', 'description', 'projectType', 'projectSubType', 'proponentName',
    'projectState', 'abbreviation', 'address', 'eaStatus', 'eacDecision', 'decisionDate'];
  const visOf = (n) => Object.fromEntries(FIELDS.slice(0, n).map((f) => [f, 4]));

  await t.test('eleven fields is one Cosmos patch operation too many', async () => {
    const { res, calls } = await classify(t, { vis: visOf(11) });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /10/);
    assert.strictEqual(calls.patchVis.length, 0);
  });

  await t.test('ten is the cap, not one under it', async () => {
    const { res, calls } = await classify(t, { vis: visOf(10) });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(Object.keys(calls.patchVis[0].vis).length, 10);
  });

  await t.test('and the cap is the one the data layer enforces', async () => {
    assert.strictEqual(cosmos.PATCH_MAX_OPERATIONS, 10);
    await assert.rejects(
      cosmos.patch('projects', '207', '207', new Array(11).fill({ op: 'set', path: '/a', value: 1 })),
      RangeError);
  });
});

test('patches, never upserts', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('the controller writes through patchVis and never through upsert', async () => {
    const { res, calls } = await classify(t, { vis: { name: 2 } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(calls.upsert.length, 0, 'an upsert would revert concurrent content writes');
    assert.deepStrictEqual(calls.patchVis, [{ id: '207', vis: { name: 2 } }]);
  });

  await t.test('the repository sets one operation per key and leaves the rest alone', async () => {
    t.mock.method(cosmos, 'readItem', async () => ({ ...STORED, vis: { description: 2 } }));
    t.mock.method(cosmos, 'upsert', async () => assert.fail('patchVis must never upsert'));
    t.mock.method(cosmos, 'replace', async () => assert.fail('patchVis must never replace'));
    const ops = [];
    t.mock.method(cosmos, 'patch', async (container, id, pk, operations) => {
      ops.push({ container, id, pk, operations });
      return { ...STORED, vis: { description: 2, name: 3 } };
    });

    await projects.patchVis('207', { name: 3 });

    assert.strictEqual(ops.length, 1);
    assert.strictEqual(ops[0].container, 'projects');
    assert.strictEqual(ops[0].pk, '207', 'partitioned by id');
    assert.deepStrictEqual(ops[0].operations, [{ op: 'set', path: '/vis/name', value: 3 }],
      'a dial the body does not name must not appear as an operation');
  });

  await t.test('an unclassified project gets its vis node created in one operation', async () => {
    // Cosmos refuses `set /vis/name` when /vis does not exist, and no write site emits `vis`, so
    // this is the ordinary case rather than an edge one.
    t.mock.method(cosmos, 'readItem', async () => ({ ...STORED }));
    const ops = [];
    t.mock.method(cosmos, 'patch', async (c, id, pk, operations) => {
      ops.push(operations);
      return { ...STORED, vis: { name: 3 } };
    });

    await projects.patchVis('207', { name: 3, description: null });

    assert.deepStrictEqual(ops, [[{ op: 'set', path: '/vis', value: { name: 3 } }]],
      'one whole-map set: there are no dials to preserve, and a null asks to remove nothing');
  });
});

test('null removes a dial', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('the controller accepts null as a level', async () => {
    const { res, calls } = await classify(t, { vis: { complianceLead: null } },
      { ...STORED, vis: { complianceLead: 1 } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(calls.patchVis[0].vis, { complianceLead: null });
  });

  await t.test('the repository turns it into a remove, not a set', async () => {
    t.mock.method(cosmos, 'readItem', async () => ({ ...STORED, vis: { name: 2, description: 3 } }));
    const ops = [];
    t.mock.method(cosmos, 'patch', async (c, id, pk, operations) => {
      ops.push(operations);
      return { ...STORED, vis: { description: 3 } };
    });

    await projects.patchVis('207', { name: null });

    assert.deepStrictEqual(ops, [[{ op: 'remove', path: '/vis/name' }]]);
  });

  await t.test('removing a dial the record never held writes nothing', async () => {
    // Cosmos errors on `remove` of an absent path, and patch() throws on an empty array, so this
    // is the one shape that has to short-circuit.
    t.mock.method(cosmos, 'readItem', async () => ({ ...STORED, vis: { description: 3 } }));
    t.mock.method(cosmos, 'patch', async () => assert.fail('nothing to remove, so no patch'));

    const out = await projects.patchVis('207', { name: null });
    assert.deepStrictEqual(out.vis, { description: 3 });
  });
});

test('audits before responding', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  t.after(() => audit._resetTransport());

  let rows = [];
  audit._setTransport(async (stream, batch) => { rows.push(...batch); });

  t.mock.method(projects, 'getById', async () => ({ ...STORED, vis: { complianceLead: 1 } }));
  t.mock.method(projects, 'patchVis', async (id, vis) => ({
    ...STORED, vis: { complianceLead: 1, ...vis }
  }));

  let rowsAtResponse = null;
  const res = mockRes();
  res.json = function (data) {
    // AUDIT_MAX_BATCH is 1, so enqueue drains through the stub synchronously: an empty buffer here
    // means the row would have been written after the caller already had its answer.
    rowsAtResponse = rows.slice();
    this.body = data;
    return this;
  };

  await projectController.setVisibility({
    params: { id: '207' }, query: {},
    body: { vis: { complianceLead: 2, name: null } }, user: SYSADMIN
  }, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(rowsAtResponse.length, 1, 'the audit row exists by the time res.json runs');

  const row = rowsAtResponse[0];
  assert.strictEqual(row.Action, 'project.reclassify');
  assert.strictEqual(row.TargetType, 'project');
  assert.strictEqual(row.TargetId, '207');
  assert.strictEqual(row.ProjectId, '207');
  assert.strictEqual(row.ActorId, 'kc-sub-1');
  assert.deepStrictEqual(row.Detail.fields, ['complianceLead', 'name']);
  assert.deepStrictEqual(row.Detail.from, { complianceLead: 1, name: null });
  assert.deepStrictEqual(row.Detail.to, { complianceLead: 2, name: null });

  // Names and levels only. A dial names the field somebody decided was sensitive, so the value of
  // that field is the last thing that belongs in a table kept for seven years.
  const detail = JSON.stringify(row.Detail);
  assert.ok(!detail.includes('Skeena LNG'), 'no field values in the audit row');
  assert.ok(!detail.includes('A. Lead'), 'no field values in the audit row');
});

test('a project the caller cannot read is a 404, and writes nothing', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  t.mock.method(projects, 'getById', async () => null);
  const patched = [];
  t.mock.method(projects, 'patchVis', async (...args) => { patched.push(args); return {}; });

  const res = mockRes();
  await projectController.setVisibility(
    { params: { id: '999' }, query: {}, body: { vis: { name: 2 } }, user: SYSADMIN }, res);

  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(patched.length, 0);
});
