'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { check } = require('../../src/domain/_schema');

const OBJECT_ID = '5c1a2b3c4d5e6f7a8b9c0d1e';
const UUID = '0b4f6c1e-2d3a-4e5f-8a9b-1c2d3e4f5a6b';

const SCHEMA = Object.freeze({
  name: { type: 'string', max: 10, required: true },
  active: { type: 'boolean' },
  kind: { type: 'enum', values: ['a', 'b'] },
  startDate: { type: 'isoDate' },
  parent: { type: 'id', nullable: true },
  pins: { type: 'idArray', max: 2 }
});

test('a body that fits the schema comes back as its value', () => {
  const body = {
    name: 'Acme', active: false, kind: 'b', startDate: '2026-10-14T09:30:00Z', parent: UUID,
    pins: [OBJECT_ID, UUID]
  };
  assert.deepStrictEqual(check(SCHEMA, body), { status: 'ok', value: body });
});

test('a key the schema does not name is a field error', () => {
  const result = check(SCHEMA, { name: 'Acme', read: ['public'] });
  assert.strictEqual(result.status, 'invalid');
  assert.deepStrictEqual(Object.keys(result.fields), ['read']);
});

test('every failing field is reported in one result', () => {
  const result = check(SCHEMA, {
    name: 'a name longer than ten', active: 'yes', kind: 'c', startDate: 'Tuesday', parent: 'x',
    pins: [OBJECT_ID, 'nope'], extra: 1
  });
  assert.deepStrictEqual(Object.keys(result.fields).sort(),
    ['active', 'extra', 'kind', 'name', 'parent', 'pins', 'startDate']);
});

test('a string one character over max is refused, at max is kept', () => {
  assert.match(check(SCHEMA, { name: 'x'.repeat(11) }).fields.name, /at most 10/);
  assert.strictEqual(check(SCHEMA, { name: 'x'.repeat(10) }).status, 'ok');
});

test('an enum refuses a value outside its list and names the list', () => {
  assert.match(check(SCHEMA, { name: 'n', kind: 'c' }).fields.kind, /a, b/);
});

test('isoDate refuses a string Date.parse would accept loosely', () => {
  assert.ok(check(SCHEMA, { name: 'n', startDate: 'Oct 14 2026' }).fields.startDate);
  assert.strictEqual(check(SCHEMA, { name: 'n', startDate: '2026-10-14' }).status, 'ok');
});

test('idArray refuses more ids than its max', () => {
  assert.match(check(SCHEMA, { name: 'n', pins: [OBJECT_ID, UUID, OBJECT_ID] }).fields.pins, /at most 2/);
});

test('null passes only a nullable field', () => {
  assert.strictEqual(check(SCHEMA, { name: 'n', parent: null }).status, 'ok');
  assert.ok(check(SCHEMA, { name: 'n', kind: null }).fields.kind);
});

test('a missing required field is an error on create and skipped on a partial update', () => {
  assert.strictEqual(check(SCHEMA, {}).fields.name, 'is required');
  assert.deepStrictEqual(check(SCHEMA, { active: true }, { partial: true }), { status: 'ok', value: { active: true } });
});

test('a body that is not an object is invalid as a whole', () => {
  assert.deepStrictEqual(check(SCHEMA, ['name']).fields, { body: 'must be a JSON object' });
});

test('a string spec without max is a schema bug, thrown not blamed on the caller', () => {
  assert.throws(() => check({ note: { type: 'string' } }, {}), /needs an integer max/);
});
