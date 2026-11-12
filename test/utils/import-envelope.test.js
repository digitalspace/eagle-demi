'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  fingerprintOf, publicKeysFromPem, sealEnvelope, openEnvelope, openExtract, sign, verify, sha256Hex
} = require('../../src/utils/import-envelope');

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
const ed = crypto.generateKeyPairSync('ed25519');
const keyFingerprint = fingerprintOf({ rsa: rsa.publicKey, ed25519: ed.publicKey });
const local = { purpose: 'extract', env: 'test', keyFingerprint, privateKey: rsa.privateKey };
const signoffRefs = { keepStaff: null, keepNumbers: null };
const pemOf = key => key.export({ type: 'spki', format: 'pem' });

function sealFor(plaintext, extra = {}) {
  return sealEnvelope(Buffer.from(plaintext), {
    purpose: 'extract', env: 'test', keyFingerprint, recipientKey: rsa.publicKey,
    staffIncluded: false, numbersReal: false, signoffRefs, ...extra
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
  const flipped = Buffer.from(tag);
  flipped[0] ^= 1;
  const tampered = [
    box => { box.tag = flipped.toString('base64'); },
    box => { box.tag = tag.subarray(0, 12).toString('base64'); },
    box => { box.header.staffIncluded = true; },
    box => { box.header.numbersReal = true; },
    box => { box.header.signoffRefs = { ...signoffRefs, keepStaff: 'X' }; },
    box => { box.header.signoffRefs = { ...signoffRefs, keepNumbers: 'X' }; }
  ];
  for (const edit of tampered) assert.throws(() => openEnvelope(rewrite(sealed, edit), local), /envelope refused/);
  assert.throws(() => openEnvelope(sealed, { ...local, purpose: 'report' }), /envelope refused/);
  assert.throws(() => openEnvelope(sealed, { ...local, env: 'prod' }), /envelope refused/);
  assert.throws(() => openEnvelope(sealed, { ...local, keyFingerprint: 'f'.repeat(64) }), /envelope refused/);
});

test('header env or fingerprint is ignored in favour of the local ones', () => {
  const forged = rewrite(sealFor('payload'), (box) => {
    box.header.env = 'prod';
    box.header.keyFingerprint = 'f'.repeat(64);
  });
  assert.equal(openEnvelope(forged, local).plaintext.toString(), 'payload');
  assert.throws(() => openEnvelope(forged, { ...local, env: 'prod', keyFingerprint: 'f'.repeat(64) }), /envelope refused/);
});

test('an extract body that disagrees with its header, or is not JSON, is refused with one message', () => {
  const body = { env: 'test', staffIncluded: false, numbersReal: false, signoffRefs, records: { projects: [{ id: 1 }] } };
  assert.equal(openExtract(sealFor(JSON.stringify(body)), local).extract.records.projects[0].id, 1);
  const bodies = [
    { ...body, env: 'prod' },
    { ...body, numbersReal: true },
    { ...body, staffIncluded: true },
    { ...body, signoffRefs: { ...signoffRefs, keepStaff: 'X' } },
    { ...body, records: { projects: [{ id: 1, epd: null }] } }
  ];
  for (const wrong of bodies) assert.throws(() => openExtract(sealFor(JSON.stringify(wrong)), local), /^Error: envelope refused/);
  assert.throws(() => openExtract(sealFor('{not json'), local), /^Error: envelope refused/);
});

test('signature over one purpose fails for another', () => {
  const sha256 = sha256Hex('csv body');
  const signature = sign(ed.privateKey, { purpose: 'crosswalk', env: 'test', sha256 });
  assert.equal(verify(ed.publicKey, { purpose: 'crosswalk', env: 'test', sha256 }, signature), true);
  assert.equal(verify(ed.publicKey, { purpose: 'report', env: 'test', sha256 }, signature), false);
  assert.equal(verify(ed.publicKey, { purpose: 'crosswalk', env: 'prod', sha256 }, signature), false);
  assert.equal(verify(ed.publicKey, { purpose: 'crosswalk', env: 'test', sha256: sha256Hex('other') }, signature), false);
  assert.throws(() => sign(rsa.privateKey, { purpose: 'crosswalk', env: 'test', sha256 }), /Ed25519/);
  assert.throws(() => verify(rsa.publicKey, { purpose: 'crosswalk', env: 'test', sha256 }, signature), /Ed25519/);
});

test('fingerprint matches a fixed test vector', () => {
  // Expected values were computed outside Node: openssl DER export, 4-byte big-endian length prefix, SHA-256.
  const keys = publicKeysFromPem(fs.readFileSync(path.join(__dirname, '../fixtures/works-import/vector-keys.pub.pem'), 'utf8'));
  assert.equal(fingerprintOf(keys), '014976c016bd6bbbc8a6a1c0f28ae6757c8b2e7aee0f346467f95280b85d3a7e');
  assert.equal(fingerprintOf({ rsa: keys.rsa }), '132cee47c9a05237d7517a100eac30fce6f85a6db81b0963b100c11a64f23296');
});

test('a PEM with an RSA key under 3072 bits is refused', () => {
  const small = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
  assert.throws(() => publicKeysFromPem(pemOf(small) + pemOf(ed.publicKey)), /under 3072 bits/);
  assert.equal(publicKeysFromPem(pemOf(rsa.publicKey)).rsa.asymmetricKeyDetails.modulusLength, 3072);
});
