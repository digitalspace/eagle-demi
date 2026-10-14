'use strict';

process.env.NODE_ENV = 'test';
// Before src/config is first required: the audit writer is inert without a collection rule.
process.env.AUDIT_DCR_ENDPOINT = 'https://dcr-test.canadacentral-1.ingest.monitor.azure.com';
process.env.AUDIT_DCR_IMMUTABLE_ID = 'dcr-testimmutableid';

const test = require('node:test');
const assert = require('node:assert');

const audit = require('../../src/utils/audit');
const { writeRow } = require('../../src/domain/_write');
const { logger } = require('../../src/utils/logger');

let rows = [];
audit._setTransport(async (stream, batch) => { rows.push(...batch); });

const CTX = { req: { user: { sub: 'u1', preferred_username: 'staff1', realm_access: { roles: ['staff'] } }, headers: {} } };
const STORED = { id: 'o1', name: 'Old', _etag: 'e1' };

/** A repository whose upsert stores each row it is given, or throws `failures` codes first. */
function fakeRepo(failures = []) {
  const stored = [];
  return {
    stored,
    upsert: async (row) => {
      if (failures.length) throw Object.assign(new Error('raced'), { code: failures.shift() });
      stored.push(row);
      return { ...row, _etag: 'e2' };
    }
  };
}

const auditOf = (saved, from) => ({ action: 'thing.update', targetType: 'thing', targetId: saved.id, detail: { from: from && from.name } });

async function auditRows(fn) {
  rows = [];
  const result = await fn();
  await audit.flush();
  return { result, rows };
}

test('a write without an audit builder throws before touching storage', async () => {
  const repo = fakeRepo();
  await assert.rejects(
    writeRow({ ctx: CTX, repo, existing: STORED, reread: async () => STORED, build: c => c }),
    /audit builder/);
  assert.strictEqual(repo.stored.length, 0);
});

test('a write that lands stores the built row and records exactly one audit row', async (t) => {
  const logged = [];
  t.mock.method(logger, 'info', (message, meta) => { logged.push(meta); });
  const repo = fakeRepo();
  const { result, rows: written } = await auditRows(() => writeRow({
    ctx: CTX, repo, existing: STORED, reread: async () => STORED,
    build: current => ({ ...current, name: 'New' }), audit: auditOf
  }));

  assert.strictEqual(result.status, 'ok');
  assert.strictEqual(result.value.name, 'New');
  assert.strictEqual(result.created, false);
  assert.strictEqual(written.length, 1);
  assert.strictEqual(written[0].Action, 'thing.update');
  assert.strictEqual(written[0].ActorName, 'staff1');
  assert.deepStrictEqual(logged, [{ action: 'thing.update', id: 'o1' }]);
});

test('a write with no existing row is a create', async () => {
  const { result } = await auditRows(() => writeRow({
    ctx: CTX, repo: fakeRepo(), existing: null, reread: async () => null,
    build: () => ({ id: 'n1', name: 'New' }), audit: auditOf
  }));
  assert.strictEqual(result.created, true);
});

test('a lost race rebuilds from the reread row and audits against it', async () => {
  const moved = { ...STORED, name: 'Moved', _etag: 'e9' };
  const repo = fakeRepo([412]);
  const { result, rows: written } = await auditRows(() => writeRow({
    ctx: CTX, repo, existing: STORED, reread: async () => moved,
    build: current => ({ ...current, note: 'added' }), audit: auditOf
  }));

  assert.strictEqual(result.value.name, 'Moved');
  assert.strictEqual(written.length, 1);
  assert.strictEqual(written[0].Detail.from, 'Moved');
});

test('every try lost answers busy and records no audit row', async (t) => {
  const lost = [];
  t.mock.method(logger, 'warn', (message, meta) => { lost.push(meta.attempt); });
  t.mock.method(logger, 'info', () => assert.fail('a busy write logs no success'));
  const repo = fakeRepo([412, 412, 412]);
  const { result, rows: written } = await auditRows(() => writeRow({
    ctx: CTX, repo, existing: STORED, reread: async () => STORED,
    build: current => ({ ...current, name: 'New' }), audit: auditOf
  }));

  assert.deepStrictEqual(result, { status: 'busy' });
  assert.strictEqual(repo.stored.length, 0);
  assert.strictEqual(written.length, 0);
  assert.deepStrictEqual(lost, [1, 2, 3]);
});

test('a build that finds no row answers not-found and records no audit row', async () => {
  const repo = fakeRepo();
  const { result, rows: written } = await auditRows(() => writeRow({
    ctx: CTX, repo, existing: STORED, reread: async () => null, build: () => null, audit: auditOf
  }));

  assert.deepStrictEqual(result, { status: 'not-found' });
  assert.strictEqual(repo.stored.length, 0);
  assert.strictEqual(written.length, 0);
});

test('a storage fault that is not a race propagates', async () => {
  await assert.rejects(writeRow({
    ctx: CTX, repo: fakeRepo([500]), existing: STORED, reread: async () => STORED,
    build: current => current, audit: auditOf
  }), /raced/);
});
