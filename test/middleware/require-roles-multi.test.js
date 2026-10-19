'use strict';

// requireRole with several names, the guard a ported eagle-api route uses for its x-security-scopes.

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { requireRole } = require('../../src/middleware/require-roles');

function run(gate, user) {
  const result = { status: null, body: null, nexted: false };
  const res = {
    status(code) { result.status = code; return this; },
    json(body) { result.body = body; return this; }
  };
  gate(user === undefined ? {} : { user }, res, () => { result.nexted = true; });
  return result;
}

const withRoles = roles => ({ realm_access: { roles } });

test('requireRole admits any one of the roles it names', () => {
  const gate = requireRole('staff', 'sysadmin');
  assert.deepStrictEqual(['staff', 'sysadmin'].map(role => run(gate, withRoles(['public', role])).nexted), [true, true]);
});

test('an unlisted role is refused with every listed name', () => {
  const r = run(requireRole('staff', 'sysadmin'), withRoles(['public', 'demi-admin', 'demi-service-write']));
  assert.deepStrictEqual(r, {
    status: 403, body: { error: 'Forbidden. Requires one of the roles staff, sysadmin.' }, nexted: false
  });
});

// eagle-api lets these two through every route; DEMI does not, so a ported guard must name them.
test('sysadmin and staff do not pass a guard that does not name them', () => {
  const gate = requireRole('project-system-admin');
  assert.deepStrictEqual(['sysadmin', 'staff'].map(role => run(gate, withRoles([role])).status), [403, 403]);
});

test('the guard carries its roles, frozen, for the route inventory', () => {
  const gate = requireRole('staff', 'sysadmin');
  assert.deepStrictEqual([...gate.roles], ['staff', 'sysadmin']);
  assert.ok(Object.isFrozen(gate.roles));
});

test('a missing req.user or role list fails closed', () => {
  const gate = requireRole('staff', 'sysadmin');
  assert.strictEqual(run(gate).status, 403);
  assert.strictEqual(run(gate, {}).status, 403);
});

test('a guard naming no role is refused at definition', () => {
  assert.throws(() => requireRole(), /at least one role/);
});

test('requireRole with one name keeps its refusal text', () => {
  assert.deepStrictEqual(run(requireRole('compliance'), withRoles(['public', 'staff'])).body,
    { error: 'Forbidden. Requires role compliance.' });
  assert.strictEqual(run(requireRole('compliance'), withRoles(['compliance'])).nexted, true);
});
