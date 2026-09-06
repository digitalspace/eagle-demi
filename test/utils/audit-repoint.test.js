'use strict';

// A SECOND file for src/utils/audit.js, and it has to be: config.js reads the environment once at
// require time and audit.js reads the audit stream name from it once at load, so the repointed
// environment cannot be set up inside test/utils/audit.test.js without reloading both.
//
// What it covers: with the eagle-analytics DCR configured, privileged actions go THERE as
// EagleAudit_CL rows while usage counters stay on DEMI's own DCR. Two destinations, one writer —
// sending either stream to the other's rule is silently rejected at ingest, so nothing downstream
// would report it.
process.env.NODE_ENV = 'test';
process.env.AUDIT_DCR_ENDPOINT = 'https://analytics-dcr.canadacentral-1.ingest.monitor.azure.com';
process.env.AUDIT_DCR_IMMUTABLE_ID = 'dcr-analyticsimmutableid';
process.env.AUDIT_STREAM_NAME = 'Custom-EagleAudit_CL';
process.env.EVENTS_DCR_ENDPOINT = 'https://demi-dcr.canadacentral-1.ingest.monitor.azure.com';
process.env.EVENTS_DCR_IMMUTABLE_ID = 'dcr-demiimmutableid';

const test = require('node:test');
const assert = require('node:assert');
const audit = require('../../src/utils/audit');

function fakeReq() {
  return {
    id: 'req-repoint',
    headers: { 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': '142.34.7.9' },
    socket: { remoteAddress: '142.34.7.9' },
    user: { sub: 'kc-sub-1', preferred_username: 'someone@idir', realm_access: { roles: ['sysadmin'] } }
  };
}

test('the repointed writer', async (t) => {
  let sent = [];

  t.beforeEach(() => {
    sent = [];
    audit._setTransport(async (stream, rows) => { sent.push({ stream, rows }); });
  });

  t.afterEach(async () => {
    await audit.flush();
    audit._resetTransport();
  });

  await t.test('sends privileged actions to the analytics stream, named as this app', async () => {
    audit.auditEvent(fakeReq(), { action: 'project.delete', targetType: 'project', targetId: 'p1' });
    await audit.flush();

    assert.strictEqual(sent[0].stream, 'Custom-EagleAudit_CL');
    assert.strictEqual(audit.AUDIT_STREAM, 'Custom-EagleAudit_CL',
      'the stream is a deployment fact, not a constant — AUDIT_STREAM_NAME decides it');
    assert.strictEqual(sent[0].rows[0].SourceApp, 'eagle-demi');
  });

  await t.test('leaves usage counters on the DEMI stream', async () => {
    audit.analyticsEvent(fakeReq(), { eventName: 'search', resultCount: 1 });
    await audit.flush();

    assert.strictEqual(sent[0].stream, 'Custom-DemiEvents_CL',
      'DemiEvents_CL is not in the analytics DCR and moving it would drop every usage row');
    assert.strictEqual(sent[0].rows[0].SourceApp, undefined,
      'the usage table has no such column, and a dropped column is a silent one');
  });

  await t.test('each stream is addressed to its own data collection rule', async () => {
    // The pair the URL is built from. Crossed over, every row is rejected by a rule that does not
    // declare that stream — a 400 the app only reports after three failed attempts.
    assert.deepStrictEqual(audit._destinationFor(audit.AUDIT_STREAM), {
      endpoint: 'https://analytics-dcr.canadacentral-1.ingest.monitor.azure.com',
      immutableId: 'dcr-analyticsimmutableid'
    });
    assert.deepStrictEqual(audit._destinationFor(audit.EVENTS_STREAM), {
      endpoint: 'https://demi-dcr.canadacentral-1.ingest.monitor.azure.com',
      immutableId: 'dcr-demiimmutableid'
    });
  });
});
