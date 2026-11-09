'use strict';

// Who may call the Track push, end to end through the dispatcher: only apim:track, as named by
// DEMI_TRACK_PRINCIPALS, because the handlers write any project unfiltered.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const trackPush = require('../../src/controllers/nosql/track-push');
const { withServer } = require('../helpers/with-server');
const { setEnv, gatewayCaller, stubRegistry } = require('../helpers/registry-callers');

const ROUTE = '/api/track/projects/207';
const BODY = JSON.stringify({ pushedAt: 1762650000000, project: { id: 207 } });

function stubHandlers(t) {
  const reached = [];
  const answer = (name) => (_req, res) => { reached.push(name); res.json({ reached: true }); };
  t.mock.method(trackPush, 'putTrackProject', answer('put'));
  t.mock.method(trackPush, 'deleteTrackProject', answer('delete'));
  return reached;
}

async function send(method, headers) {
  let status;
  await withServer(async (call) => {
    status = (await call(ROUTE, { method, headers: { 'content-type': 'application/json', ...headers }, body: BODY })).status;
  });
  return status;
}

test('the Track push admits Track and nobody else', async (t) => {
  t.beforeEach((t) => setEnv(t, 'DEMI_TRACK_PRINCIPALS', undefined));
  t.afterEach(() => t.mock.restoreAll());

  await t.test('apim:engage gets 403 on PUT', async (t) => {
    const reached = stubHandlers(t);
    const engage = gatewayCaller(t, 'engage', ['demi-service-write']);
    stubRegistry(t, [engage.row]);

    assert.strictEqual(await send('PUT', engage.headers), 403);
    assert.deepStrictEqual(reached, []);
  });

  await t.test('apim:engage gets 403 on DELETE', async (t) => {
    const reached = stubHandlers(t);
    const engage = gatewayCaller(t, 'engage', ['demi-service-write']);
    stubRegistry(t, [engage.row]);

    assert.strictEqual(await send('DELETE', engage.headers), 403);
    assert.deepStrictEqual(reached, []);
  });

  await t.test('apim:track reaches both handlers by default', async (t) => {
    const reached = stubHandlers(t);
    const track = gatewayCaller(t, 'track', ['demi-service-write']);
    stubRegistry(t, [track.row]);

    assert.strictEqual(await send('PUT', track.headers), 200);
    assert.strictEqual(await send('DELETE', track.headers), 200);
    assert.deepStrictEqual(reached, ['put', 'delete']);
  });

  await t.test('an empty DEMI_TRACK_PRINCIPALS refuses Track too', async (t) => {
    const reached = stubHandlers(t);
    setEnv(t, 'DEMI_TRACK_PRINCIPALS', '');
    const track = gatewayCaller(t, 'track', ['demi-service-write']);
    stubRegistry(t, [track.row]);

    assert.strictEqual(await send('PUT', track.headers), 403);
    assert.deepStrictEqual(reached, []);
  });
});
