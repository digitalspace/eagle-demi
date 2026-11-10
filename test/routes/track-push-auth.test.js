'use strict';

// Who may call the Track push, end to end through the dispatcher: only apim:track, as named by
// DEMI_TRACK_PRINCIPALS, because the handlers write any project unfiltered.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const trackPush = require('../../src/controllers/nosql/track-push');
const { withServer } = require('../helpers/with-server');
const { setEnv, gatewayCaller, stubRegistry } = require('../helpers/registry-callers');

/** Every route of the record contract, with the handler it must reach. */
const ROUTES = [
  ['POST', '/api/track/projects', 'postTrackProject'],
  ['PUT', '/api/track/projects/207', 'putTrackProject'],
  ['DELETE', '/api/track/projects/207', 'deleteTrackProject'],
  ['POST', '/api/track/projects/207/works', 'postTrackWork'],
  ['PUT', '/api/track/projects/207/works/2001', 'putTrackWork'],
  ['DELETE', '/api/track/projects/207/works/2001?pushedAt=1762650000000&workTypeId=6', 'deleteTrackWork'],
  ['POST', '/api/track/projects/207/phases', 'postTrackPhase'],
  ['PUT', '/api/track/projects/207/phases/3001', 'putTrackPhase'],
  ['DELETE', '/api/track/projects/207/phases/3001?pushedAt=1762650000000&workTypeId=6', 'deleteTrackPhase'],
  ['POST', '/api/track/projects/207/events', 'postTrackEvent'],
  ['PUT', '/api/track/projects/207/events/4001', 'putTrackEvent'],
  ['DELETE', '/api/track/projects/207/events/4001?pushedAt=1762650000000&workTypeId=6', 'deleteTrackEvent']
];
const BODY = JSON.stringify({ pushedAt: 1762650000000, project: { id: 207 } });

function stubHandlers(t) {
  const reached = [];
  for (const [, , name] of ROUTES) {
    t.mock.method(trackPush, name, (_req, res) => { reached.push(name); res.json({ reached: true }); });
  }
  return reached;
}

async function send(method, route, headers) {
  let status;
  await withServer(async (call) => {
    status = (await call(route, { method, headers: { 'content-type': 'application/json', ...headers }, body: BODY })).status;
  });
  return status;
}

test('the Track push admits Track and nobody else', async (t) => {
  t.beforeEach((t) => setEnv(t, 'DEMI_TRACK_PRINCIPALS', undefined));
  t.afterEach(() => t.mock.restoreAll());

  for (const [method, route, handler] of ROUTES) {
    await t.test(`apim:engage gets 403 on ${method} ${route}`, async (t) => {
      const reached = stubHandlers(t);
      const engage = gatewayCaller(t, 'engage', ['demi-service-write']);
      stubRegistry(t, [engage.row]);

      assert.strictEqual(await send(method, route, engage.headers), 403);
      assert.deepStrictEqual(reached, []);
    });

    await t.test(`apim:track reaches ${handler} by default`, async (t) => {
      const reached = stubHandlers(t);
      const track = gatewayCaller(t, 'track', ['demi-service-write']);
      stubRegistry(t, [track.row]);

      assert.strictEqual(await send(method, route, track.headers), 200);
      assert.deepStrictEqual(reached, [handler]);
    });
  }

  await t.test('an empty DEMI_TRACK_PRINCIPALS refuses Track too', async (t) => {
    const reached = stubHandlers(t);
    setEnv(t, 'DEMI_TRACK_PRINCIPALS', '');
    const track = gatewayCaller(t, 'track', ['demi-service-write']);
    stubRegistry(t, [track.row]);

    assert.strictEqual(await send('PUT', '/api/track/projects/207', track.headers), 403);
    assert.deepStrictEqual(reached, []);
  });
});
