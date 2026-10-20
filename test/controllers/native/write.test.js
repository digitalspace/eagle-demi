'use strict';

// writeHandler through the real router response object, with a stub domain function per case.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { writeHandler } = require('../../../src/controllers/native/write');
const { makeRes } = require('../../../src/http/router');
const { logger } = require('../../../src/utils/logger');

const STAFF = { realm_access: { roles: ['staff'] } };
const PUBLIC = { realm_access: { roles: ['public'] } };
// `description` is level 2 in catalog/lists.js; `name` is public.
const ROW = { id: 'o1', kind: 'Organization', name: 'Acme', description: 'staff note', read: ['public'] };

async function call(fn, { user = STAFF, id, body = {} } = {}) {
  const req = { params: id === undefined ? {} : { id }, query: {}, headers: {}, header: () => undefined, user, body };
  const res = makeRes('test');
  await writeHandler(fn, { entity: 'lists' })(req, res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
}

const answering = (result) => async () => result;

test('a route without :id calls fn(ctx, body)', async () => {
  let seen;
  await call(async (...args) => { seen = args; return { status: 'ok', value: ROW }; }, { body: { name: 'Acme' } });
  assert.strictEqual(seen.length, 2);
  assert.deepStrictEqual(seen[1], { name: 'Acme' });
  assert.ok(seen[0].access && seen[0].req, 'ctx carries access and req');
});

test('a route with :id calls fn(ctx, id, body)', async () => {
  let seen;
  await call(async (...args) => { seen = args; return { status: 'ok', value: ROW }; }, { id: 'o1', body: { name: 'B' } });
  assert.deepStrictEqual(seen.slice(1), ['o1', { name: 'B' }]);
});

test('ok answers 200 with the saved row', async () => {
  const r = await call(answering({ status: 'ok', value: ROW }), { id: 'o1' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.name, 'Acme');
});

test('ok on a created row answers 201', async () => {
  const r = await call(answering({ status: 'ok', value: ROW, created: true }));
  assert.strictEqual(r.status, 201);
});

// Also the proof that ctx.access comes from the caller: only the access level differs here.
test('the saved row is redacted for the caller', async () => {
  assert.strictEqual((await call(answering({ status: 'ok', value: ROW }), { user: STAFF })).body.description, 'staff note');
  assert.strictEqual((await call(answering({ status: 'ok', value: ROW }), { user: PUBLIC })).body.description, undefined);
});

test('invalid answers 400 with every field error', async () => {
  const fields = { name: 'is required', read: 'is not a writable field' };
  const r = await call(answering({ status: 'invalid', fields }));
  assert.strictEqual(r.status, 400);
  assert.deepStrictEqual(r.body.fields, fields);
  assert.strictEqual(typeof r.body.error, 'string');
});

test('forbidden answers 403 with the domain message', async () => {
  const r = await call(answering({ status: 'forbidden', error: 'Only staff may change pins.' }));
  assert.deepStrictEqual(r, { status: 403, body: { error: 'Only staff may change pins.' } });
});

test('not-found answers 404', async () => {
  assert.strictEqual((await call(answering({ status: 'not-found' }), { id: 'x' })).status, 404);
});

test('conflict answers 409', async () => {
  assert.strictEqual((await call(answering({ status: 'conflict', error: 'Name taken.' }))).status, 409);
});

test('busy answers 503 with the body every staff write uses for a lost race', async () => {
  const r = await call(answering({ status: 'busy' }));
  assert.deepStrictEqual(r, { status: 503, body: { error: 'The record is being written by another request. Try again.' } });
});

test('a dependency not set up answers 503, a failing one 502, each with the domain message', async () => {
  assert.deepStrictEqual(await call(answering({ status: 'unavailable', error: 'Not set up.' })),
    { status: 503, body: { error: 'Not set up.' } });
  assert.deepStrictEqual(await call(answering({ status: 'upstream-failed' })), { status: 502, body: { error: 'Bad gateway.' } });
});

test('a thrown error answers 500 without its message', async () => {
  const r = await call(async () => { throw new Error('cosmos endpoint https://secret.example'); });
  assert.strictEqual(r.status, 500);
  assert.doesNotMatch(JSON.stringify(r.body), /secret\.example/);
});

test('an unknown status is a 500, not a silent 200', async () => {
  assert.strictEqual((await call(answering({ status: 'saved', value: ROW }))).status, 500);
});

test('every refusal logs a warning naming the entity and status, never the body values', async (t) => {
  const warned = [];
  t.mock.method(logger, 'warn', (message, meta) => { warned.push({ message, meta }); });

  await call(answering({ status: 'invalid', fields: { name: 'must be a string' } }), { id: 'o1', body: { name: 42 } });
  for (const status of ['forbidden', 'not-found', 'conflict', 'busy']) await call(answering({ status }), { id: 'o1' });

  assert.deepStrictEqual(warned.map(w => w.meta), ['invalid', 'forbidden', 'not-found', 'conflict', 'busy']
    .map(status => ({ entity: 'lists', id: 'o1', status })));
  assert.match(warned[0].message, /invalid name$/);
});

test('an invalid body with many keys logs at most ten field names', async (t) => {
  const warned = [];
  t.mock.method(logger, 'warn', (message) => { warned.push(message); });
  const fields = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, 'is not a writable field']));

  await call(answering({ status: 'invalid', fields }));

  assert.strictEqual(warned[0].split(': invalid ')[1].split(', ').length, 10);
});

test('a write that lands logs no warning', async (t) => {
  t.mock.method(logger, 'warn', () => assert.fail('an ok write is not a refusal'));
  assert.strictEqual((await call(answering({ status: 'ok', value: ROW }))).status, 200);
});
