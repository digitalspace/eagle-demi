'use strict';

// Laptop-side tool: reads the business workbooks and hands DEMI only sealed envelopes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { parseArgs } = require('util');
const { readFolder } = require('./cells');
const { openSurrogates, surrogateOf } = require('./surrogates');
const {
  STAFF_FIELDS, fingerprintOf, recipientFromPem, sealEnvelope, openEnvelope, sha256Hex, verify
} = require('../../src/utils/import-envelope');

const ENVS = ['test', 'prod'];
const MIN_PASSPHRASE = 20;
const KEYRING_SERVICE = 'eagle-demi-works-import';
const SEALED_SUFFIX = '.sealed.json';
const SEAL_PURPOSES = ['crosswalk', 'manual-match'];
const OPEN_PURPOSES = ['crosswalk', 'report'];

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

function refuseExisting(...files) {
  const taken = files.filter(f => fs.existsSync(f));
  if (taken.length) throw new Error(`${taken.join(', ')} already exists`);
}

function sealedOut(file) {
  if (!file.endsWith(SEALED_SUFFIX)) throw new Error(`--out must end with ${SEALED_SUFFIX}`);
  return file;
}

function need(opts, ...names) {
  const missing = names.filter(n => !opts[n]);
  if (missing.length) throw new Error(`missing --${missing.join(', --')}`);
  if (opts.env && !ENVS.includes(opts.env)) throw new Error(`--env must be one of ${ENVS.join(', ')}`);
}

const recipientOf = (pemFile, expectFingerprint) => recipientFromPem(fs.readFileSync(pemFile, 'utf8'), expectFingerprint, pemFile);

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
  let surrogates = null;
  if (policy.numbersReal && (o.surrogates || o['new-surrogates'])) {
    throw new Error('--surrogates and --new-surrogates apply only when numbers are replaced (--env test without --keep-numbers-on-test)');
  }
  if (!policy.numbersReal) {
    need(o, 'surrogates', 'surrogate-passphrase-ref');
    surrogates = openSurrogates(o.surrogates, {
      create: Boolean(o['new-surrogates']), readPassphrase: () => passphraseFrom(o['surrogate-passphrase-ref'], io.env)
    });
  }
  try {
    const data = await readFolder(o.in);
    for (const row of Object.values(data.records).flat()) {
      if (!policy.staffIncluded) STAFF_FIELDS.forEach(f => delete row[f]);
      if (surrogates && 'id' in row) row.id = surrogateOf(surrogates.map, row.id);
    }
    if (surrogates) surrogates.save();
    const plaintext = Buffer.from(JSON.stringify({ schemaVersion: 1, env: o.env, ...policy, ...data }));
    writeNew(o.out, sealEnvelope(plaintext, {
      purpose: 'extract', env: o.env, keyFingerprint: fingerprint, recipientKey: keys.rsa, ...policy
    }));
    Object.entries(data.counts).forEach(([key, n]) => io.write(`${key}=${n}`));
    const kinds = data.flags.reduce((acc, f) => ({ ...acc, [f.kind]: (acc[f.kind] || 0) + 1 }), {});
    Object.entries(kinds).forEach(([kind, n]) => io.write(`flag.${kind}=${n}`));
    io.write(`plaintextSha256=${sha256Hex(plaintext)}`);
  } finally {
    if (surrogates) surrogates.release();
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
