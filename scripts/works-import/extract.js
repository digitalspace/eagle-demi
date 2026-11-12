'use strict';

// Laptop-side tool: reads the business workbooks and hands DEMI only sealed envelopes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { parseArgs } = require('util');
const { readFolder } = require('./cells');
const {
  STAFF_FIELDS, fingerprintOf, publicKeysFromPem, sealEnvelope, openEnvelope, sha256Hex, verify
} = require('../../src/utils/import-envelope');

const ENVS = ['test', 'prod'];
const MIN_PASSPHRASE = 20;
const KEYRING_SERVICE = 'eagle-demi-works-import';
const SEALED_SUFFIX = '.sealed.json';
const DEFAULT_SURROGATES = 'works-surrogates.enc.json';
const SEAL_PURPOSES = ['crosswalk', 'manual-match'];
const OPEN_PURPOSES = ['crosswalk', 'report'];
const SURROGATE_AAD = Buffer.from('works-import-surrogates');
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function keyringCommand(ref) {
  if (ref.startsWith('op://')) return ['op', ['read', '--no-newline', ref]];
  if (process.platform === 'darwin') return ['security', ['find-generic-password', '-s', KEYRING_SERVICE, '-a', ref, '-w']];
  if (process.platform === 'win32') throw new Error('keyring lookup is not supported on win32; use an op:// reference');
  return ['secret-tool', ['lookup', 'service', KEYRING_SERVICE, 'account', ref]];
}

/** Reads a secret from the OS keyring or a 1Password `op://` reference; never from a file. */
function readSecretRef(ref, env) {
  const [cmd, args] = keyringCommand(ref);
  let secret = '';
  try {
    secret = execFileSync(cmd, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\r?\n$/, '');
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`${cmd} is not installed`, { cause: err });
  }
  if (!secret) throw new Error(`no keyring entry for ${ref}`);
  return secret;
}

function passphraseFrom(ref, env) {
  const secret = readSecretRef(ref, env);
  if (secret.length < MIN_PASSPHRASE) throw new Error(`passphrase for ${ref} is shorter than ${MIN_PASSPHRASE} characters`);
  return secret;
}

const writeNew = (file, data) => fs.writeFileSync(file, data, { mode: 0o600, flag: 'wx' });
const surrogateKey = (passphrase, salt) => crypto.scryptSync(passphrase, salt, 32, SCRYPT);

function refuseExisting(...files) {
  const taken = files.filter(f => fs.existsSync(f));
  if (taken.length) throw new Error(`${taken.join(', ')} already exists`);
}

function sealedOut(file) {
  if (!file.endsWith(SEALED_SUFFIX)) throw new Error(`--out must end with ${SEALED_SUFFIX}`);
  return file;
}

function loadSurrogates(file, passphrase) {
  try {
    const box = JSON.parse(fs.readFileSync(file, 'utf8'));
    const iv = Buffer.from(box.iv, 'base64');
    const tag = Buffer.from(box.tag, 'base64');
    if (iv.length !== 12 || tag.length !== 16) throw new Error('shape');
    const decipher = crypto.createDecipheriv('aes-256-gcm',
      surrogateKey(passphrase, Buffer.from(box.salt, 'base64')), iv, { authTagLength: 16 });
    decipher.setAAD(SURROGATE_AAD);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(Buffer.from(box.ciphertext, 'base64')), decipher.final()]);
    return new Map(JSON.parse(plain.toString('utf8')));
  } catch {
    throw new Error(`surrogate map ${file} could not be opened`);
  }
}

function saveSurrogates(file, map, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', surrogateKey(passphrase, salt), iv, { authTagLength: 16 });
  cipher.setAAD(SURROGATE_AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify([...map])), cipher.final()]);
  const tmp = `${file}.${process.pid}.tmp`;
  writeNew(tmp, JSON.stringify({
    v: 1, salt: salt.toString('base64'), iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64')
  }));
  fs.renameSync(tmp, file);
}

function surrogateOf(map, id) {
  if (!map.has(id)) {
    const used = new Set(map.values());
    let next;
    do next = crypto.randomInt(100000, 1000000); while (used.has(next));
    map.set(id, next);
  }
  return map.get(id);
}

/**
 * Opens the surrogate map under an exclusive lock. A missing map is refused unless --new-surrogates:
 * a fresh map re-mints every surrogate, and the next load tombstones and re-creates every test sheet work.
 */
function openSurrogates(o, env) {
  const file = o.surrogates || DEFAULT_SURROGATES;
  const exists = fs.existsSync(file);
  if (!exists && !o['new-surrogates']) throw new Error(`surrogate map ${file} not found; pass --new-surrogates to start one`);
  if (exists && o['new-surrogates']) throw new Error(`surrogate map ${file} exists; drop --new-surrogates`);
  need(o, 'surrogate-passphrase-ref');
  const passphrase = passphraseFrom(o['surrogate-passphrase-ref'], env);
  const lock = `${file}.lock`;
  try {
    writeNew(lock, String(process.pid));
  } catch (err) {
    throw new Error(err.code === 'EEXIST' ? `${lock} exists: another run holds the surrogate map` : `${lock} cannot be created`,
      { cause: err });
  }
  try {
    return { file, lock, passphrase, map: exists ? loadSurrogates(file, passphrase) : new Map() };
  } catch (err) {
    fs.rmSync(lock, { force: true });
    throw err;
  }
}

function need(opts, ...names) {
  const missing = names.filter(n => !opts[n]);
  if (missing.length) throw new Error(`missing --${missing.join(', --')}`);
  if (opts.env && !ENVS.includes(opts.env)) throw new Error(`--env must be one of ${ENVS.join(', ')}`);
}

function recipientOf(pemFile, expectFingerprint) {
  const keys = publicKeysFromPem(fs.readFileSync(pemFile, 'utf8'));
  const fingerprint = fingerprintOf(keys);
  if (fingerprint !== String(expectFingerprint).toLowerCase()) throw new Error(`fingerprint of ${pemFile} does not match`);
  return { keys, fingerprint };
}

const shaLabel = purpose => `${purpose.replace(/-(\w)/g, (_, c) => c.toUpperCase())}Sha256`;

function keygen(o, io) {
  need(o, 'env', 'out-dir', 'passphrase-ref');
  const base = path.join(o['out-dir'], `operator-${o.env}`);
  refuseExisting(`${base}.key.pem`, `${base}.pub.pem`);
  const passphrase = passphraseFrom(o['passphrase-ref'], io.env);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }
  });
  writeNew(`${base}.key.pem`, privateKey);
  writeNew(`${base}.pub.pem`, publicKey);
  io.write(`fingerprint=${fingerprintOf({ rsa: publicKey })}`);
}

function policyOf(o) {
  const keepStaff = o['keep-staff-on-test'] || null;
  const keepNumbers = o['keep-numbers-on-test'] || null;
  if (o.env !== 'test' && (keepStaff || keepNumbers)) throw new Error('--keep-*-on-test apply to --env test only');
  return {
    staffIncluded: o.env !== 'test' || Boolean(keepStaff),
    numbersReal: o.env !== 'test' || Boolean(keepNumbers),
    signoffRefs: { keepStaff, keepNumbers }
  };
}

async function extract(o, io) {
  need(o, 'env', 'in', 'recipient-key', 'expect-fingerprint', 'out');
  refuseExisting(sealedOut(o.out));
  const { keys, fingerprint } = recipientOf(o['recipient-key'], o['expect-fingerprint']);
  const policy = policyOf(o);
  const surrogates = policy.numbersReal ? null : openSurrogates(o, io.env);
  try {
    const data = await readFolder(o.in);
    for (const row of Object.values(data.records).flat()) {
      if (!policy.staffIncluded) STAFF_FIELDS.forEach(f => delete row[f]);
      if (surrogates && 'id' in row) row.id = surrogateOf(surrogates.map, row.id);
    }
    if (surrogates) saveSurrogates(surrogates.file, surrogates.map, surrogates.passphrase);
    const plaintext = Buffer.from(JSON.stringify({ schemaVersion: 1, env: o.env, ...policy, ...data }));
    writeNew(o.out, sealEnvelope(plaintext, {
      purpose: 'extract', env: o.env, keyFingerprint: fingerprint, recipientKey: keys.rsa, ...policy
    }));
    Object.entries(data.counts).forEach(([key, n]) => io.write(`${key}=${n}`));
    const kinds = data.flags.reduce((acc, f) => ({ ...acc, [f.kind]: (acc[f.kind] || 0) + 1 }), {});
    Object.entries(kinds).forEach(([kind, n]) => io.write(`flag.${kind}=${n}`));
    io.write(`plaintextSha256=${sha256Hex(plaintext)}`);
  } finally {
    if (surrogates) fs.rmSync(surrogates.lock, { force: true });
  }
}

function seal(o, io) {
  need(o, 'env', 'purpose', 'in', 'recipient-key', 'expect-fingerprint', 'out');
  if (!SEAL_PURPOSES.includes(o.purpose)) throw new Error(`--purpose must be one of ${SEAL_PURPOSES.join(', ')}`);
  refuseExisting(sealedOut(o.out));
  const { keys, fingerprint } = recipientOf(o['recipient-key'], o['expect-fingerprint']);
  const plaintext = fs.readFileSync(o.in);
  const sha256 = sha256Hex(plaintext);
  let signature;
  if (o.purpose === 'crosswalk') {
    need(o, 'signature');
    signature = fs.readFileSync(o.signature, 'utf8').trim();
    if (!keys.ed25519 || !verify(keys.ed25519, { purpose: o.purpose, env: o.env, sha256 }, signature)) {
      throw new Error('crosswalk signature does not verify');
    }
  }
  writeNew(o.out, sealEnvelope(plaintext, {
    purpose: o.purpose, env: o.env, keyFingerprint: fingerprint, recipientKey: keys.rsa, signature
  }));
  io.write(`${shaLabel(o.purpose)}=${sha256}`);
}

function open(o, io) {
  need(o, 'env', 'purpose', 'in', 'out', 'key', 'passphrase-ref', 'devbox-key', 'devbox-fingerprint', 'expect-sha256');
  if (!OPEN_PURPOSES.includes(o.purpose)) throw new Error(`--purpose must be one of ${OPEN_PURPOSES.join(', ')}`);
  refuseExisting(o.out, `${o.out}.sig`);
  const devbox = recipientOf(o['devbox-key'], o['devbox-fingerprint']).keys;
  const privateKey = crypto.createPrivateKey({
    key: fs.readFileSync(o.key), passphrase: passphraseFrom(o['passphrase-ref'], io.env)
  });
  const keyFingerprint = fingerprintOf({ rsa: crypto.createPublicKey(privateKey) });
  const opened = openEnvelope(fs.readFileSync(o.in), { purpose: o.purpose, env: o.env, keyFingerprint, privateKey });
  const sha256 = sha256Hex(opened.plaintext);
  if (!devbox.ed25519 || !verify(devbox.ed25519, { purpose: o.purpose, env: o.env, sha256 }, opened.signature)) {
    throw new Error('devbox signature does not verify');
  }
  if (sha256 !== String(o['expect-sha256']).toLowerCase()) throw new Error('SHA-256 does not match --expect-sha256');
  writeNew(o.out, opened.plaintext);
  writeNew(`${o.out}.sig`, `${opened.signature}\n`);
  io.write(`${shaLabel(o.purpose)}=${sha256}`);
}

const COMMANDS = { keygen, extract, seal, open };
const OPTIONS = {
  ...Object.fromEntries([
    'env', 'in', 'out', 'out-dir', 'passphrase-ref', 'recipient-key', 'expect-fingerprint', 'keep-staff-on-test',
    'keep-numbers-on-test', 'surrogates', 'surrogate-passphrase-ref', 'purpose', 'signature', 'key', 'devbox-key',
    'devbox-fingerprint', 'expect-sha256'
  ].map(name => [name, { type: 'string' }])),
  'new-surrogates': { type: 'boolean' }
};

async function run(argv, { env = process.env, write = line => process.stdout.write(`${line}\n`) } = {}) {
  const [command, ...rest] = argv;
  const handler = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
  if (!handler) throw new Error(`usage: extract.js <${Object.keys(COMMANDS).join('|')}> [options]`);
  const { values } = parseArgs({ args: rest, options: OPTIONS, strict: true, allowPositionals: false });
  await handler(values, { env, write });
}

module.exports = { run };

// stderr, not src/utils/logger: the logger loads src/config.js, which throws under some laptop env settings.
if (require.main === module) {
  run(process.argv.slice(2)).then(() => process.exit(0)).catch((err) => {
    process.stderr.write(`[works-extract] ${err.message}\n`);
    process.exit(1);
  });
}
