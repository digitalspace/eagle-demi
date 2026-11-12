'use strict';

const crypto = require('crypto');

const ENVELOPE_VERSION = 1;
const STAFF_FIELDS = Object.freeze(['epd', 'lead', 'notes', 'investment']);
const PEM_BLOCK = /-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/g;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function asPublicKey(key) {
  return key instanceof crypto.KeyObject && key.type === 'public' ? key : crypto.createPublicKey(key);
}

/** SHA-256 over the length-prefixed SPKI DER of the RSA key, then the Ed25519 key when given. */
function fingerprintOf({ rsa, ed25519 }) {
  if (!rsa) throw new Error('fingerprintOf needs an RSA key');
  const parts = [rsa, ed25519].filter(Boolean).map((key) => {
    const der = asPublicKey(key).export({ type: 'spki', format: 'der' });
    const len = Buffer.alloc(4);
    len.writeUInt32BE(der.length);
    return Buffer.concat([len, der]);
  });
  return sha256Hex(Buffer.concat(parts));
}

/** Reads a PEM file holding one RSA and at most one Ed25519 public key. */
function publicKeysFromPem(text) {
  const keys = {};
  for (const block of String(text).match(PEM_BLOCK) || []) {
    const key = crypto.createPublicKey(block);
    const kind = key.asymmetricKeyType;
    if ((kind !== 'rsa' && kind !== 'ed25519') || keys[kind]) throw new Error(`unexpected ${kind} key in PEM`);
    keys[kind] = key;
  }
  if (!keys.rsa) throw new Error('PEM holds no RSA public key');
  return keys;
}

function aadOf({ purpose, env, keyFingerprint, staffIncluded, numbersReal, signoffRefs }) {
  if (!purpose || !env || !keyFingerprint) throw new Error('purpose, env and keyFingerprint are required');
  return Buffer.from(canonicalJson({
    purpose, env, keyFingerprint,
    staffIncluded: staffIncluded ?? null,
    numbersReal: numbersReal ?? null,
    signoffRefs: signoffRefs ?? null
  }));
}

/**
 * AES-256-GCM with the key wrapped by RSA-OAEP (SHA-256). `env` and `keyFingerprint` sit in the
 * header for people only; openEnvelope rebuilds them from the reader's own values.
 */
function sealEnvelope(plaintext, { purpose, env, keyFingerprint, recipientKey, staffIncluded, numbersReal, signoffRefs, signature }) {
  const header = {
    v: ENVELOPE_VERSION, purpose, env, keyFingerprint,
    staffIncluded: staffIncluded ?? null, numbersReal: numbersReal ?? null, signoffRefs: signoffRefs ?? null
  };
  if (signature) header.signature = signature;
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aadOf(header));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const wrappedKey = crypto.publicEncrypt(
    { key: asPublicKey(recipientKey), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  return Buffer.from(JSON.stringify({
    header,
    wrappedKey: wrappedKey.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  }));
}

function openEnvelope(sealed, { purpose, env, keyFingerprint, privateKey }) {
  const aadInput = { purpose, env, keyFingerprint };
  try {
    const box = JSON.parse(Buffer.isBuffer(sealed) ? sealed.toString('utf8') : sealed);
    const { header } = box;
    if (!header || header.v !== ENVELOPE_VERSION) throw new Error('version');
    const key = crypto.privateDecrypt(
      { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(box.wrappedKey, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
    decipher.setAAD(aadOf({ ...aadInput, staffIncluded: header.staffIncluded, numbersReal: header.numbersReal, signoffRefs: header.signoffRefs }));
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(box.ciphertext, 'base64')), decipher.final()]);
    return {
      plaintext,
      staffIncluded: header.staffIncluded,
      numbersReal: header.numbersReal,
      signoffRefs: header.signoffRefs,
      signature: header.signature || null
    };
  } catch {
    // One message for every cause, so a caller cannot probe which check failed.
    throw new Error(`envelope refused for purpose ${purpose}, env ${env}`);
  }
}

function hasStaffField(extract) {
  return Object.values(extract.records || {}).some(rows =>
    rows.some(row => STAFF_FIELDS.some(f => Object.prototype.hasOwnProperty.call(row, f))));
}

/** Opens an extract and refuses it when its staff columns disagree with the signed header. */
function openExtract(sealed, opts) {
  const opened = openEnvelope(sealed, { ...opts, purpose: 'extract' });
  const extract = JSON.parse(opened.plaintext.toString('utf8'));
  if (hasStaffField(extract) !== (opened.staffIncluded === true)) {
    throw new Error('extract staff columns disagree with staffIncluded');
  }
  return { ...opened, extract };
}

function statementOf({ purpose, env, sha256 }) {
  if (!purpose || !env || !/^[0-9a-f]{64}$/.test(String(sha256))) throw new Error('purpose, env and a sha256 are required');
  return Buffer.from(canonicalJson({ purpose, env, sha256 }));
}

/** Ed25519 over canonical {purpose, env, sha256}, so a signature for one purpose fails for another. */
function sign(privateKey, statement) {
  return crypto.sign(null, statementOf(statement), privateKey).toString('base64');
}

function verify(publicKey, statement, signature) {
  try {
    return crypto.verify(null, statementOf(statement), asPublicKey(publicKey), Buffer.from(String(signature), 'base64'));
  } catch {
    return false;
  }
}

module.exports = {
  STAFF_FIELDS,
  canonicalJson,
  sha256Hex,
  fingerprintOf,
  publicKeysFromPem,
  sealEnvelope,
  openEnvelope,
  openExtract,
  sign,
  verify
};
