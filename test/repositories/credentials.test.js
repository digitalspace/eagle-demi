'use strict';

/**
 * Selected Credentials repository — what a project close writes.
 *
 * The dangerous direction is a close that takes access it was not asked to take: a grant naming
 * three projects must lose the closed one and keep the other two, so every assertion below is on
 * the patch operation and the audit row, not on a return value.
 */

process.env.NODE_ENV = 'test';
// Before src/config is first required: the audit writer is inert without these, and a batch of 1
// drains through the stub transport as each row is appended.
process.env.AUDIT_DCR_ENDPOINT = 'https://dcr-test.canadacentral-1.ingest.monitor.azure.com';
process.env.AUDIT_DCR_IMMUTABLE_ID = 'dcr-testimmutableid';
process.env.AUDIT_MAX_BATCH = '1';

const test = require('node:test');
const assert = require('node:assert');

const audit = require('../../src/utils/audit');
const cosmos = require('../../src/db/cosmos-nosql');
const credentials = require('../../src/repositories/credentials');

const grant = (id, ids, partyId) => ({
  id,
  party: { type: 'user', id: partyId },
  scope: { type: 'project', ids },
  levels: [2],
  batchId: 'batch-a',
  revokedAt: null
});

let rows = [];
audit._setTransport(async (_stream, batch) => { rows.push(...batch); });

/**
 * Applies the clause the repository sent rather than returning a canned set, so a revoke that
 * dropped the project binding or the live guard is visible here as extra rows.
 */
function fakeCosmos(t, stored) {
  const patched = [];
  t.mock.method(cosmos, 'query', async (_container, spec) => {
    const projectId = (spec.parameters || []).find(p => p.name === '@projectId');
    return {
      items: stored.filter(row =>
        (!/c\.scope\.type = 'project'/.test(spec.query) || row.scope.type === 'project') &&
        (!projectId || row.scope.ids.includes(projectId.value)) &&
        (!/IS_NULL\(c\.revokedAt\)/.test(spec.query) || !row.revokedAt))
    };
  });
  t.mock.method(cosmos, 'patch', async (container, id, pk, operations) => {
    patched.push({ container, id, pk, operations });
    return {};
  });
  return patched;
}

async function auditRows(fn) {
  rows = [];
  const out = await fn();
  await audit.flush();
  return { out, rows };
}

test('a project close narrows a multi-project grant and revokes a single-project one', async (t) => {
  t.afterEach(() => t.mock.restoreAll());
  t.after(() => audit._resetTransport());

  await t.test('a grant over other projects keeps them', async () => {
    const patched = fakeCosmos(t, [grant('c1', ['207', '311', '412'], 'u1')]);

    const { rows: audited } = await auditRows(
      () => credentials.revokeForProject('207', 'project-closed'));

    assert.deepStrictEqual(patched[0].operations, [
      { op: 'set', path: '/scope/ids', value: ['311', '412'] }
    ], 'the closed id is dropped, revokedAt is not stamped');
    assert.strictEqual(patched[0].pk, 'u1', 'patched in the party partition');

    assert.strictEqual(audited.length, 1);
    assert.strictEqual(audited[0].Action, 'credential.narrow');
    assert.strictEqual(audited[0].TargetId, 'c1');
    assert.strictEqual(audited[0].ProjectId, '207');
    assert.deepStrictEqual(audited[0].Detail.removed, ['207']);
    assert.strictEqual(audited[0].Detail.remaining, 2);
    assert.strictEqual(audited[0].Detail.cause, 'project-closed');
  });

  await t.test('a grant over the closed project alone is revoked', async () => {
    const patched = fakeCosmos(t, [grant('c2', ['207'], 'u2')]);

    const { rows: audited } = await auditRows(
      () => credentials.revokeForProject('207', 'project-closed'));

    assert.strictEqual(patched.length, 1);
    assert.strictEqual(patched[0].operations[0].op, 'set');
    assert.strictEqual(patched[0].operations[0].path, '/revokedAt');
    assert.ok(patched[0].operations[0].value, 'stamped, never deleted — the row is the record');

    assert.strictEqual(audited[0].Action, 'credential.revoke');
    assert.strictEqual(audited[0].TargetId, 'c2');
    assert.strictEqual(audited[0].Detail.cause, 'project-closed');
  });

  await t.test('a mixed set: one narrowed, one revoked, one untouched', async () => {
    const stored = [
      grant('c1', ['207', '311'], 'u1'),
      grant('c2', ['207'], 'u2'),
      grant('c3', ['311'], 'u3')
    ];
    const patched = fakeCosmos(t, stored);

    const { out, rows: audited } = await auditRows(
      () => credentials.revokeForProject('207', 'project-closed'));

    assert.deepStrictEqual(out.map(r => r.id), ['c1', 'c2'], 'the other project is untouched');
    assert.deepStrictEqual(patched.map(p => [p.id, p.operations[0].path]), [
      ['c1', '/scope/ids'],
      ['c2', '/revokedAt']
    ]);
    assert.deepStrictEqual(audited.map(r => r.Action), ['credential.narrow', 'credential.revoke']);
  });

  await t.test('a document-scoped grant is left alone: its ids are document ids', async () => {
    const documentGrant = {
      ...grant('c4', ['d1'], 'u4'), scope: { type: 'document', ids: ['d1'] }
    };
    const patched = fakeCosmos(t, [documentGrant]);

    const { out } = await auditRows(() => credentials.revokeForProject('207', 'project-closed'));

    assert.deepStrictEqual(out, []);
    assert.deepStrictEqual(patched, []);
  });
});

test('listLiveProjectScoped reads every live project grant in one query', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  const stored = [
    grant('c1', ['207', '311'], 'u1'),
    { ...grant('c2', ['412'], 'u2'), revokedAt: '2026-01-01T00:00:00.000Z' },
    { ...grant('c3', ['d1'], 'u3'), scope: { type: 'document', ids: ['d1'] } }
  ];
  const specs = [];
  t.mock.method(cosmos, 'query', async (_container, spec, options) => {
    specs.push({ spec, options });
    return {
      items: stored.filter(row => row.scope.type === 'project' && !row.revokedAt)
    };
  });

  assert.deepStrictEqual((await credentials.listLiveProjectScoped()).map(r => r.id), ['c1']);
  assert.strictEqual(specs.length, 1);
  assert.match(specs[0].spec.query, /c\.scope\.type = 'project'/);
  assert.match(specs[0].spec.query, /IS_NULL\(c\.revokedAt\)/);
  assert.strictEqual(specs[0].options, undefined, 'cross-partition: no partition key');
});
