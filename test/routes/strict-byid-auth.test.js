'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const config = require('../../src/config');
const projectController = require('../../src/controllers/nosql/project');
const documentController = require('../../src/controllers/nosql/document');
const inspectionController = require('../../src/controllers/nosql/inspection');
const { logger } = require('../../src/utils/logger');
const { withServer } = require('../helpers/with-server');

// eagle-admin refreshes its token on a 401. A rejected Bearer served the public view under a 200
// instead, so staff saw records vanish rather than a refresh.
const READS = [
  ['/api/projects/p1', projectController, 'getProject'],
  ['/api/documents/recent-uploads', documentController, 'getRecentUploads'],
  ['/api/documents/d1', documentController, 'getDocument'],
  ['/api/documents/d1/download', documentController, 'downloadDocument'],
  ['/api/inspections', inspectionController, 'getInspections'],
  ['/api/inspections/i1', inspectionController, 'getInspection']
];

/** Every read's status, and who each handler that ran saw as the caller. */
async function callReads(t, headers) {
  const callers = [];
  for (const [, controller, name] of READS) {
    t.mock.method(controller, name, (req, res) => {
      callers.push(req.user ? req.user.preferred_username : 'anonymous');
      res.json({});
    });
  }
  const statuses = [];
  await withServer(async (call) => {
    for (const [path] of READS) statuses.push((await call(path, { headers })).status);
  });
  return { statuses, callers };
}

function keycloak(t, enabled) {
  const keycloakEnabled = config.keycloakEnabled;
  config.keycloakEnabled = enabled;
  t.after(() => { config.keycloakEnabled = keycloakEnabled; });
}

const sixOf = value => READS.map(() => value);

test('by-id reads refuse a rejected Bearer', async (t) => {
  await t.test('a rejected Bearer answers 401 and never reaches the handler', async (t) => {
    keycloak(t, true);
    t.mock.method(logger, 'warn', () => {});
    const { statuses, callers } = await callReads(t, { authorization: 'Bearer not-a-real-token' });
    assert.deepStrictEqual(statuses, sixOf(401));
    assert.deepStrictEqual(callers, []);
  });

  await t.test('no Bearer still reads as anonymous under a 200', async (t) => {
    const { statuses, callers } = await callReads(t, {});
    assert.deepStrictEqual(statuses, sixOf(200));
    assert.deepStrictEqual(callers, sixOf('anonymous'));
  });

  await t.test('a valid staff Bearer reaches the handler as that caller', async (t) => {
    keycloak(t, false);
    const token = jwt.sign({ preferred_username: 'idir-staff', realm_access: { roles: ['staff'] } }, 'suite-only');
    const { statuses, callers } = await callReads(t, { authorization: `Bearer ${token}` });
    assert.deepStrictEqual(statuses, sixOf(200));
    assert.deepStrictEqual(callers, sixOf('idir-staff'));
  });
});
