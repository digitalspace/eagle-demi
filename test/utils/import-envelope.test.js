'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  fingerprintOf, publicKeysFromPem, sealEnvelope, openEnvelope, openExtract, sign, verify, sha256Hex
} = require('../../src/utils/import-envelope');

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ed = crypto.generateKeyPairSync('ed25519');
const keyFingerprint = fingerprintOf({ rsa: rsa.publicKey, ed25519: ed.publicKey });
const local = { purpose: 'extract', env: 'test', keyFingerprint, privateKey: rsa.privateKey };

function sealFor(plaintext, extra = {}) {
  return sealEnvelope(Buffer.from(plaintext), {
    purpose: 'extract', env: 'test', keyFingerprint, recipientKey: rsa.publicKey,
    staffIncluded: false, numbersReal: false, signoffRefs: { keepStaff: null, keepNumbers: null }, ...extra
  });
}

function rewrite(sealed, edit) {
  const box = JSON.parse(sealed.toString('utf8'));
  edit(box);
  return Buffer.from(JSON.stringify(box));
}

test('envelope fails on a tampered tag, wrong purpose, env or fingerprint', () => {
  const sealed = sealFor('payload');
  assert.equal(openEnvelope(sealed, local).plaintext.toString(), 'payload');

  const tag = Buffer.from(JSON.parse(sealed).tag, 'base64');
  tag[0] ^= 1;
  assert.throws(() => openEnvelope(rewrite(sealed, box => { box.tag = tag.toString('base64'); }), local), /envelope refused/);
  assert.throws(() => openEnvelope(sealed, { ...local, purpose: 'report' }), /envelope refused/);
  assert.throws(() => openEnvelope(sealed, { ...local, env: 'prod' }), /envelope refused/);
  assert.throws(() => openEnvelope(sealed, { ...local, keyFingerprint: 'f'.repeat(64) }), /envelope refused/);
  assert.throws(() => openEnvelope(rewrite(sealed, box => { box.header.staffIncluded = true; }), local), /envelope refused/);
});

test('header env or fingerprint is ignored in favour of the local ones', () => {
  const forged = rewrite(sealFor('payload'), (box) => {
    box.header.env = 'prod';
    box.header.keyFingerprint = 'f'.repeat(64);
  });
  assert.equal(openEnvelope(forged, local).plaintext.toString(), 'payload');
  assert.throws(() => openEnvelope(forged, { ...local, env: 'prod', keyFingerprint: 'f'.repeat(64) }), /envelope refused/);
});

test('an extract whose staff columns disagree with staffIncluded is refused', () => {
  const withStaff = JSON.stringify({ records: { projects: [{ id: 1, epd: null }] } });
  assert.throws(() => openExtract(sealFor(withStaff), local), /disagree with staffIncluded/);
  assert.equal(openExtract(sealFor(withStaff, { staffIncluded: true }), local).extract.records.projects[0].id, 1);
});

test('signature over one purpose fails for another', () => {
  const sha256 = sha256Hex('csv body');
  const signature = sign(ed.privateKey, { purpose: 'crosswalk', env: 'test', sha256 });
  assert.equal(verify(ed.publicKey, { purpose: 'crosswalk', env: 'test', sha256 }, signature), true);
  assert.equal(verify(ed.publicKey, { purpose: 'report', env: 'test', sha256 }, signature), false);
  assert.equal(verify(ed.publicKey, { purpose: 'crosswalk', env: 'prod', sha256 }, signature), false);
  assert.equal(verify(ed.publicKey, { purpose: 'crosswalk', env: 'test', sha256: sha256Hex('other') }, signature), false);
});

test('fingerprint matches a fixed test vector', () => {
  // Expected values were computed outside Node: openssl DER export, 4-byte big-endian length prefix, SHA-256.
  const keys = publicKeysFromPem(fs.readFileSync(path.join(__dirname, '../fixtures/works-import/vector-keys.pub.pem'), 'utf8'));
  assert.equal(fingerprintOf(keys), '0a4cdebb0b37667499b026229c848c6ffd4e117e31e3fdb0203522f1513e99fc');
  assert.equal(fingerprintOf({ rsa: keys.rsa }), '4603b25b2e751c2878b746ddfe6d6c9652753f6925b504efee11217ee954430d');
});
