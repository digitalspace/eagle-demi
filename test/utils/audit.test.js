'use strict';

process.env.NODE_ENV = 'test';
// Both must be present or the writer is inert by design. The values are never dialled — the
// transport is stubbed below — they only have to be non-empty.
process.env.AUDIT_DCR_ENDPOINT = 'https://dcr-test.canadacentral-1.ingest.monitor.azure.com';
process.env.AUDIT_DCR_IMMUTABLE_ID = 'dcr-testimmutableid';

const test = require('node:test');
const assert = require('node:assert');
const config = require('../../src/config');
const audit = require('../../src/utils/audit');

function fakeReq(overrides = {}) {
  return {
    id: 'req-abc123',
    headers: { 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': '142.34.7.9' },
    socket: { remoteAddress: '142.34.7.9' },
    user: {
      sub: 'kc-sub-1',
      preferred_username: 'someone@idir',
      realm_access: { roles: ['sysadmin', 'project:abc'] }
    },
    ...overrides
  };
}

test('audit writer', async (t) => {
  let sent = [];

  t.beforeEach(() => {
    sent = [];
    audit._setTransport(async (stream, rows) => { sent.push({ stream, rows }); });
  });

  t.afterEach(async () => {
    await audit.flush();
    audit._resetTransport();
  });

  await t.test('buffers rather than sending on every call', async () => {
    audit.auditEvent(fakeReq(), { action: 'project.delete', targetType: 'project', targetId: 'p1' });
    assert.strictEqual(sent.length, 0, 'nothing should leave the process before a flush');

    await audit.flush();
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].stream, audit.AUDIT_STREAM);
    assert.strictEqual(sent[0].rows.length, 1);
  });

  await t.test('records actor, correlation id and unmasked IP for the DCR to mask', async () => {
    audit.auditEvent(fakeReq(), {
      action: 'document.delete',
      outcome: 'denied',
      targetType: 'document',
      targetId: 'd9',
      projectId: 'p1',
      detail: { reason: 'not permitted' }
    });
    await audit.flush();

    const row = sent[0].rows[0];
    assert.strictEqual(row.Action, 'document.delete');
    assert.strictEqual(row.Outcome, 'denied');
    assert.strictEqual(row.ActorId, 'kc-sub-1');
    assert.strictEqual(row.ActorType, 'user');
    assert.strictEqual(row.CorrelationId, 'req-abc123');
    assert.strictEqual(row.TargetId, 'd9');
    assert.strictEqual(row.ProjectId, 'p1');
    assert.deepStrictEqual(row.Detail, { reason: 'not permitted' });
    // Masking is the DCR's job, not this module's — the row leaves here whole.
    assert.strictEqual(row.SourceIp, '142.34.7.9');
    // `project:*` roles belong to the other dimension and must not land in ActorRoles.
    assert.ok(row.ActorRoles.includes('sysadmin'));
    assert.ok(!row.ActorRoles.includes('project:abc'));
  });

  await t.test('analytics rows carry no durable identity', async () => {
    audit.analyticsEvent(fakeReq(), { eventName: 'search', searchTerm: 'pipeline', resultCount: 12 });
    await audit.flush();

    const row = sent[0].rows[0];
    assert.strictEqual(sent[0].stream, audit.EVENTS_STREAM);
    assert.strictEqual(row.EventName, 'search');
    assert.strictEqual(row.ResultCount, 12);
    assert.ok(row.AnonId && row.AnonId.length === 32);
    // The two fields that would make this table an identity store.
    assert.strictEqual(row.ActorId, undefined);
    assert.strictEqual(row.SourceIp, undefined);
    // Same caller, same day, same hash — otherwise distinct-user counts are meaningless.
    const first = row.AnonId;
    sent = [];
    audit.analyticsEvent(fakeReq(), { eventName: 'search' });
    await audit.flush();
    assert.strictEqual(sent[0].rows[0].AnonId, first);
    // A different caller must not collide.
    sent = [];
    audit.analyticsEvent(fakeReq({ headers: { 'user-agent': 'curl/8', 'x-forwarded-for': '8.8.8.8' } }),
      { eventName: 'search' });
    await audit.flush();
    assert.notStrictEqual(sent[0].rows[0].AnonId, first);
  });

  await t.test('flushes early once the count ceiling is reached', async () => {
    for (let i = 0; i < config.auditMaxBatch; i++) {
      audit.auditEvent(fakeReq(), { action: 'project.update', targetId: `p${i}` });
    }
    // enqueue() fires the flush itself at the ceiling; give the microtask a turn.
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].rows.length, config.auditMaxBatch);
  });

  await t.test('splits on the byte ceiling, so no batch can exceed the ingestion limit', () => {
    const big = { Detail: 'x'.repeat(300000) };
    const parts = audit._batches([big, big, big, big], 100, 800000);
    assert.ok(parts.length > 1, 'four 300 KB rows cannot be one 800 KB batch');
    for (const part of parts) {
      assert.ok(Buffer.byteLength(JSON.stringify(part)) <= 800000);
    }
  });

  await t.test('a failing transport loses the rows to the error log, never to the caller', async () => {
    audit._setTransport(async () => { throw new Error('503 upstream'); });

    assert.doesNotThrow(() => {
      audit.auditEvent(fakeReq(), { action: 'project.delete', targetId: 'p1' });
    });
    // Three attempts, then give up — and still resolve.
    await audit.flush();
  });
});
