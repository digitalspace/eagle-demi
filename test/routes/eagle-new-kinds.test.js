'use strict';

/**
 * The user, group and inspection mirror routes and the two CSV reports, run through the dispatcher:
 * each path reaches its handler, and only behind the guard docs/rbac-architecture.md and the README
 * name for it.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const projectsRepo = require('../../src/repositories/projects');
const userController = require('../../src/controllers/nosql/user');
const groupController = require('../../src/controllers/nosql/group');
const inspectionController = require('../../src/controllers/nosql/inspection');
const commentExportController = require('../../src/controllers/nosql/comment-export');
const reportController = require('../../src/controllers/report');
const { withServer } = require('../helpers/with-server');
const { setEnv, gatewayCaller, stubRegistry } = require('../helpers/registry-callers');

const EAGLE_ID = '5c1f7a3e9b1d2c0012345678';

const MIRROR_PUTS = [
  { path: `/api/eagle/users/${EAGLE_ID}`, controller: userController, handler: 'upsertFromEagle' },
  { path: `/api/eagle/groups/${EAGLE_ID}`, controller: groupController, handler: 'upsertFromEagle' },
  { path: `/api/eagle/inspections/${EAGLE_ID}`, controller: inspectionController, handler: 'upsertInspectionFromEagle' },
  { path: `/api/eagle/inspection-elements/${EAGLE_ID}`, controller: inspectionController, handler: 'upsertElementFromEagle' },
  { path: `/api/eagle/inspection-items/${EAGLE_ID}`, controller: inspectionController, handler: 'upsertItemFromEagle' }
];

const MIRROR_GETS = [
  { path: '/api/users', controller: userController, handler: 'getUsers' },
  { path: '/api/users/u1', controller: userController, handler: 'getUser' },
  { path: '/api/groups?project=p1', controller: groupController, handler: 'getGroups' },
  { path: '/api/groups/g1?project=p1', controller: groupController, handler: 'getGroup' },
  { path: '/api/inspections?project=p1', controller: inspectionController, handler: 'getInspections' },
  { path: '/api/inspections/i1?inspection=i1', controller: inspectionController, handler: 'getInspection' },
  { path: '/api/inspection-elements?inspection=i1', controller: inspectionController, handler: 'getInspectionElements' },
  { path: '/api/inspection-elements/e1?inspection=i1', controller: inspectionController, handler: 'getInspectionElement' },
  { path: '/api/inspection-items?inspection=i1&element=e1', controller: inspectionController, handler: 'getInspectionItems' },
  { path: '/api/inspection-items/t1?inspection=i1', controller: inspectionController, handler: 'getInspectionItem' }
];

/** Replace one handler with a marker, so the response says whether the chain let the call through. */
function stubHandler(t, controller, handler) {
  const reached = { count: 0 };
  t.mock.method(controller, handler, (req, res) => {
    reached.count++;
    res.json({ reached: handler });
  });
  return reached;
}

async function call(path, init) {
  let result;
  await withServer(async (fetchLike) => {
    const res = await fetchLike(path, init);
    result = { status: res.status, type: res.headers.get('content-type'), text: await res.text() };
  });
  return result;
}

function put(path, headers = {}) {
  return call(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ doc: { _id: EAGLE_ID } })
  });
}

test('the user, group and inspection mirror PUTs', async (t) => {
  t.beforeEach((t) => setEnv(t, 'DEMI_EAGLE_MIRROR_PRINCIPALS', undefined));
  t.afterEach(() => t.mock.restoreAll());

  for (const route of MIRROR_PUTS) {
    await t.test(`${route.path} refuses an anonymous push`, async (t) => {
      const reached = stubHandler(t, route.controller, route.handler);

      const res = await put(route.path);

      assert.strictEqual(res.status, 401);
      assert.strictEqual(reached.count, 0);
    });

    await t.test(`${route.path} lets eagle-api reach ${route.handler}`, async (t) => {
      const reached = stubHandler(t, route.controller, route.handler);
      const eagleApi = gatewayCaller(t, 'eagle-api', ['demi-service-write']);
      stubRegistry(t, [eagleApi.row]);

      const res = await put(route.path, eagleApi.headers);

      assert.strictEqual(res.status, 200, res.text);
      assert.strictEqual(reached.count, 1);
    });
  }
});

test('the user, group and inspection mirror GETs read anonymously', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  for (const route of MIRROR_GETS) {
    await t.test(`${route.path} reaches ${route.handler} with no credential`, async (t) => {
      const reached = stubHandler(t, route.controller, route.handler);

      const res = await call(route.path);

      assert.strictEqual(res.status, 200, res.text);
      assert.strictEqual(reached.count, 1);
    });
  }

  await t.test('an anonymous inspection list is an empty array when nothing public is stored', async (t) => {
    const containers = [];
    t.mock.method(cosmos, 'query', async (container) => {
      containers.push(container);
      return { items: [] };
    });

    const res = await call('/api/inspections');

    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(JSON.parse(res.text), []);
    assert.deepStrictEqual(containers, ['inspections']);
  });
});

test('the CSV report routes', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('the comment export refuses a caller with no token', async (t) => {
    const reached = stubHandler(t, commentExportController, 'exportComments');

    const res = await call('/api/commentperiods/cp1/comments/export');

    assert.strictEqual(res.status, 401);
    assert.strictEqual(reached.count, 0);
  });

  await t.test('the BCGW report answers CSV to a caller with no token', async (t) => {
    t.mock.method(projectsRepo, 'listPage', async () => []);

    const res = await call('/api/reports?type=bcgw');

    assert.strictEqual(res.status, 200, res.text);
    assert.match(res.type, /^text\/csv/);
    assert.strictEqual(res.text, `${reportController.BCGW_COLUMNS.join(',')}\n`);
  });
});
