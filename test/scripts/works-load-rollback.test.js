'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { openBackup } = require('../../src/scripts/works-import-backup');
const { KINDS } = require('../../src/scripts/works-import-batch');
const { OVERRIDE_MARKER_ID } = require('../../src/domain/work-model');
const { fakeLists, amendment, register } = require('../helpers/works-import-fakes');
const { T0, TRACK, keys, operator, STAFF, inputs, liveRun } = require('../helpers/works-import-loader');
const { rollbackDemi, rollback } = require('../helpers/works-import-rollback');
const { tmp, secrets, fresh, cli } = require('../fixtures/works-import/harness');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const DAY = 24 * 60 * 60 * 1000;
const withoutSystem = doc => Object.fromEntries(Object.entries(doc).filter(([key]) => !key.startsWith('_')));
const staffEntry = (id, sheetKey) => ({ id, role: 'epd', name: 'staff-value-0', effectiveFrom: null, effectiveTo: null, source: 'sheet', sheetKey });

/** What a rollback must put back: every stored work and marker, and the row's external ids and staff history. */
function stateOf(demi) {
  const works = Object.fromEntries([...demi.docs].filter(([id]) => id !== OVERRIDE_MARKER_ID).map(([id, doc]) => [id, withoutSystem(doc)]));
  const marker = demi.docs.has(OVERRIDE_MARKER_ID) ? withoutSystem(demi.docs.get(OVERRIDE_MARKER_ID)) : null;
  const { externalIds, staffAssignments, capitalInvestments, staffNotes } = demi.row;
  return { works, marker, externalIds, staffAssignments, capitalInvestments, staffNotes };
}

// The operator's key as `works:extract keygen` writes it, under the passphrase the harness keyring holds.
function operatorKeyFile() {
  const file = path.join(fresh('operator'), 'operator-test.key.pem');
  fs.writeFileSync(file, operator.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: secrets.operator }), { mode: 0o600 });
  return file;
}

function devboxPublicFile() {
  const file = path.join(fresh('devbox-pub'), 'devbox.pub.pem');
  fs.writeFileSync(file, [keys.rsa, keys.ed25519].map(key => crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' })).join(''));
  return file;
}

/** The operator reseals the works-backup in `outDir` to the devbox; resolves the resealed path. */
async function reseal(outDir, { backupBlob, backupSha256 }) {
  const out = path.join(fresh('resealed'), 'works-backup.sealed.json');
  await cli(['reseal', '--env', 'test', '--purpose', 'works-backup', '--in', path.join(outDir, backupBlob), '--out', out,
    '--key', operatorKeyFile(), '--passphrase-ref', 'operator', '--recipient-key', devboxPublicFile(),
    '--expect-fingerprint', keys.fingerprint, '--expect-sha256', backupSha256]);
  return out;
}

test('a live load, resealed by the operator and rolled back, leaves works, markers, external ids and staff history as before', async (t) => {
  const store = fakeLists(t);
  const demi = rollbackDemi();
  await liveRun(inputs(), demi);
  demi.row = { ...demi.row, staffAssignments: [staffEntry('o1', 'register:epd'), staffEntry('o2', 'register:gone')], capitalInvestments: [], staffNotes: [] };
  const before = stateOf(demi);

  const given = inputs({ flags: STAFF, records: {
    projects: [{ ...register, epd: 'staff-value-1', lead: 'staff-value-2', notes: 'staff-value-3' }],
    amendments: [amendment(1, '2023-06-01', '2023-12-01'), amendment(2, '2015-03-01', '2015-05-07')]
  } });
  const batchId = (await liveRun(given, demi, { signoff: 'so-staff', at: T0 + DAY })).value('batchId');
  const actions = new Set(store.all().filter(item => item.kind === KINDS.ENTRY && item.batchId === batchId).map(item => item.action));
  assert.deepEqual([...actions].sort(), ['addExternalId', 'appendHistory', 'closeHistory', 'create', 'derive', 'marker', 'update'], 'the load writes every kind of entry');

  const header = store.get(batchId, KINDS.BATCH);
  const devboxKey = given.argv[given.argv.indexOf('--devbox-key') + 1];
  const argv = ['--rollback', batchId, '--backup', await reseal(given.outDir, header), '--expect-backup-sha256', header.backupSha256,
    '--devbox-key', devboxKey, '--expect-devbox-fingerprint', keys.fingerprint];
  const { code } = await rollback(argv, demi, { at: T0 + DAY + 60 * 1000, backup: openBackup });

  assert.equal(code, 0);
  assert.deepEqual(stateOf(demi), before);
  assert.deepEqual(TRACK.map(doc => demi.docs.get(doc.id)._etag), ['"t"', '"t"'], 'Track documents are never written');
  assert.equal(store.get(batchId, KINDS.BATCH).status, 'rolledBack');
});
