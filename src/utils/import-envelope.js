'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ENVELOPE_VERSION = 1;
const MIN_RSA_BITS = 3072;
const STAFF_FIELDS = Object.freeze(['epd', 'lead', 'notes', 'investment']);
const PEM_BLOCK = /-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/g;
const PRIVATE_PEM_BLOCK = /-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/g;
const OAEP = { padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' };

// Unlike `canonical` in src/domain/extensions.js, this drops keys whose value is undefined.
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

/** At most one RSA key of at least 3072 bits and at most one Ed25519 key, from the PEM blocks `pattern` finds. */
function keysFromPem(text, pattern, make) {
  const keys = {};
  for (const block of String(text).match(pattern) || []) {
    const key = make(block);
    const kind = key.asymmetricKeyType;
    if ((kind !== 'rsa' && kind !== 'ed25519') || keys[kind]) throw new Error(`unexpected ${kind} key in PEM`);
    if (kind === 'rsa' && key.asymmetricKeyDetails.modulusLength < MIN_RSA_BITS) {
      throw new Error(`RSA key is under ${MIN_RSA_BITS} bits`);
    }
    keys[kind] = key;
  }
  return keys;
}

/** Reads a PEM file holding one RSA key of at least 3072 bits and at most one Ed25519 public key. */
function publicKeysFromPem(text) {
  const keys = keysFromPem(text, PEM_BLOCK, block => crypto.createPublicKey(block));
  if (!keys.rsa) throw new Error('PEM holds no RSA public key');
  return keys;
}

/** The devbox's unencrypted PKCS#8 RSA and Ed25519 private keys, and the fingerprint the extract was sealed to. */
function devboxKeysFromPem(text) {
  const keys = keysFromPem(text, PRIVATE_PEM_BLOCK, block => crypto.createPrivateKey(block));
  if (!keys.rsa || !keys.ed25519) throw new Error('devbox key PEM must hold one RSA and one Ed25519 private key');
  const fingerprint = fingerprintOf({ rsa: crypto.createPublicKey(keys.rsa), ed25519: crypto.createPublicKey(keys.ed25519) });
  return { ...keys, fingerprint };
}

/** The public keys in `pemText`, refused unless their fingerprint is `expectFingerprint`. */
function recipientFromPem(pemText, expectFingerprint, label) {
  const keys = publicKeysFromPem(pemText);
  const fingerprint = fingerprintOf(keys);
  if (fingerprint !== String(expectFingerprint).toLowerCase()) throw new Error(`fingerprint of ${label} does not match`);
  return { keys, fingerprint };
}

/**
 * Reads one regular file of at most `max` bytes, refusing a symbolic link, a FIFO, or growth past the cap.
 * `check` gets the fstat of the open file, so its checks and the read see the same file.
 */
function readCapped(file, max, { label = file, noFollow = fs.constants.O_NOFOLLOW, check } = {}) {
  if (!noFollow && fs.lstatSync(file).isSymbolicLink()) throw new Error(`${label} is a symbolic link`);
  let fd;
  try {
    // O_NONBLOCK so a FIFO opens at once and is refused below, instead of waiting for a writer.
    fd = fs.openSync(file, fs.constants.O_RDONLY | (noFollow || 0) | (fs.constants.O_NONBLOCK || 0));
  } catch (err) {
    throw new Error(err.code === 'ELOOP' ? `${label} is a symbolic link` : `${label} cannot be opened`, { cause: err });
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
    if (check) check(stat);
    const chunks = [];
    const chunk = Buffer.alloc(1024 * 1024);
    let total = 0;
    for (let n = fs.readSync(fd, chunk); n > 0; n = fs.readSync(fd, chunk)) {
      total += n;
      if (total > max) throw new Error(`${label} is over ${max} bytes`);
      chunks.push(Buffer.from(chunk.subarray(0, n)));
    }
    return Buffer.concat(chunks, total);
  } finally {
    fs.closeSync(fd);
  }
}

function aadOf({ purpose, env, keyFingerprint, staffIncluded, numbersReal, signoffRefs }) {
  if (!purpose || !env || !keyFingerprint) throw new Error('purpose, env and keyFingerprint are required');
  return Buffer.from(canonicalJson({
    v: ENVELOPE_VERSION, purpose, env, keyFingerprint,
    staffIncluded: staffIncluded ?? null,
    numbersReal: numbersReal ?? null,
    signoffRefs: signoffRefs ?? null
  }));
}

/**
 * AES-256-GCM, key wrapped by RSA-OAEP (SHA-256). `env` and `keyFingerprint` in the header are for
 * people only; openEnvelope rebuilds them from the reader's own values.
 */
function sealEnvelope(plaintext, { purpose, env, keyFingerprint, recipientKey, staffIncluded, numbersReal, signoffRefs, signature }) {
  const header = {
    v: ENVELOPE_VERSION, purpose, env, keyFingerprint,
    staffIncluded: staffIncluded ?? null, numbersReal: numbersReal ?? null, signoffRefs: signoffRefs ?? null
  };
  if (signature) header.signature = signature;
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(aadOf(header));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const wrappedKey = crypto.publicEncrypt({ key: asPublicKey(recipientKey), ...OAEP }, key);
  return Buffer.from(JSON.stringify({
    header,
    wrappedKey: wrappedKey.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  }));
}

const refused = (purpose, env) => new Error(`envelope refused for purpose ${purpose}, env ${env}`);

function openEnvelope(sealed, { purpose, env, keyFingerprint, privateKey }) {
  try {
    const box = JSON.parse(Buffer.isBuffer(sealed) ? sealed.toString('utf8') : sealed);
    const { header } = box;
    const iv = Buffer.from(box.iv, 'base64');
    const tag = Buffer.from(box.tag, 'base64');
    if (!header || header.v !== ENVELOPE_VERSION || iv.length !== 12 || tag.length !== 16) throw new Error('shape');
    const key = crypto.privateDecrypt({ key: privateKey, ...OAEP }, Buffer.from(box.wrappedKey, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    decipher.setAAD(aadOf({
      purpose, env, keyFingerprint,
      staffIncluded: header.staffIncluded, numbersReal: header.numbersReal, signoffRefs: header.signoffRefs
    }));
    decipher.setAuthTag(tag);
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
    throw refused(purpose, env);
  }
}

function hasStaffField(extract) {
  return Object.values(extract.records).some(rows =>
    rows.some(row => STAFF_FIELDS.some(f => Object.prototype.hasOwnProperty.call(row, f))));
}

/**
 * Opens an extract and refuses a body whose env, flags or staff columns disagree with the signed header.
 * With `expectSha256`, the plaintext is hashed and refused on a mismatch before it is parsed.
 */
function openExtract(sealed, { expectSha256, ...opts }) {
  const opened = openEnvelope(sealed, { ...opts, purpose: 'extract' });
  const sha256 = sha256Hex(opened.plaintext);
  if (expectSha256 !== undefined && sha256 !== String(expectSha256).toLowerCase()) {
    throw new Error('extract SHA-256 does not match the expected value');
  }
  let extract;
  try {
    extract = JSON.parse(opened.plaintext.toString('utf8'));
  } catch {
    throw refused('extract', opts.env);
  }
  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const shaped = isObject(extract) && isObject(extract.records)
    && Object.values(extract.records).every(rows => Array.isArray(rows) && rows.every(isObject));
  if (!shaped) throw refused('extract', opts.env);
  const agrees = extract.env === opts.env
    && extract.staffIncluded === opened.staffIncluded
    && extract.numbersReal === opened.numbersReal
    && canonicalJson(extract.signoffRefs ?? null) === canonicalJson(opened.signoffRefs ?? null)
    && hasStaffField(extract) === (opened.staffIncluded === true);
  if (!agrees) throw refused('extract', opts.env);
  return { ...opened, sha256, extract };
}

function statementOf({ purpose, env, sha256 }) {
  if (!purpose || !env || !/^[0-9a-f]{64}$/.test(String(sha256))) throw new Error('purpose, env and a sha256 are required');
  return Buffer.from(canonicalJson({ purpose, env, sha256 }));
}

function ed25519(key, make) {
  const keyObject = key instanceof crypto.KeyObject ? key : make(key);
  if (keyObject.asymmetricKeyType !== 'ed25519') throw new Error('signing needs an Ed25519 key');
  return keyObject;
}

/** Ed25519 over canonical {purpose, env, sha256}, so a signature for one purpose fails for another. */
function sign(privateKey, statement) {
  return crypto.sign(null, statementOf(statement), ed25519(privateKey, crypto.createPrivateKey)).toString('base64');
}

function verify(publicKey, statement, signature) {
  const key = ed25519(publicKey, crypto.createPublicKey);
  try {
    return crypto.verify(null, statementOf(statement), key, Buffer.from(String(signature), 'base64'));
  } catch {
    return false;
  }
}

/** An output folder that exists, is no symbolic link, is this user's, and that no one else may write to. */
function checkOutDir(dir) {
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) throw new Error('--out-dir does not exist');
  const mine = typeof process.getuid !== 'function' || stat.uid === process.getuid();
  if (!stat.isDirectory() || !mine || (stat.mode & 0o022) !== 0) throw new Error('--out-dir must be a folder of this user that no one else may write to');
}

/**
 * Signs `plaintext` with the devbox Ed25519 key and seals it to `recipient` ({rsa, fingerprint}) under a random
 * name, 0600; `dir` is checked again right before, so a swap after the start is refused. Nothing plain is written.
 */
function writeSealed(dir, plaintext, { purpose, env, recipient, signingKey }) {
  checkOutDir(dir);
  const sha256 = sha256Hex(plaintext);
  const signature = sign(signingKey, { purpose, env, sha256 });
  const name = `${crypto.randomUUID()}.sealed.json`;
  fs.writeFileSync(path.join(dir, name), sealEnvelope(plaintext, {
    purpose, env, keyFingerprint: recipient.fingerprint, recipientKey: recipient.rsa, signature
  }), { mode: 0o600, flag: 'wx' });
  return { name, sha256 };
}

module.exports = {
  STAFF_FIELDS,
  sha256Hex,
  fingerprintOf,
  publicKeysFromPem,
  devboxKeysFromPem,
  recipientFromPem,
  readCapped,
  sealEnvelope,
  openEnvelope,
  openExtract,
  sign,
  verify,
  checkOutDir,
  writeSealed
};
