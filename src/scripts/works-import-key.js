'use strict';

// Makes the devbox works-import key: one PKCS#8 PEM with an RSA-OAEP 4096 key and an Ed25519 key, as
// devboxKeysFromPem reads it. Run on the devbox; prints the public keys and their combined fingerprint.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { devboxKeysFromPem } = require('../utils/import-envelope');
const { logger } = require('../utils/logger');

const DEFAULT_DIR = '/home/demi/works-import';
const KEY_FILE = 'devbox-key.pem';
const RSA_BITS = 4096;

const pemOf = (key, type) => key.export({ type, format: 'pem' });

/** The key directory at 0700, made when absent; refused when it is a symbolic link, not a directory, or another user's. */
function keyDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('key directory is not a directory');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('key directory belongs to another user');
  fs.chmodSync(dir, 0o700);
}

/** The public keys and fingerprint of `keys`, as the operator records them. */
function publicLines(keys, label) {
  return [`${label}Fingerprint=${keys.fingerprint}`,
    pemOf(crypto.createPublicKey(keys.rsa), 'spki').trim(), pemOf(crypto.createPublicKey(keys.ed25519), 'spki').trim()];
}

/** A new file at 0600; with `rotate`, written beside the old one and renamed over it, so no reader sees half a key. */
function writeKey(file, pem, rotate) {
  if (!rotate) {
    try {
      fs.writeFileSync(file, pem, { mode: 0o600, flag: 'wx' });
    } catch (err) {
      if (err.code === 'EEXIST') throw new Error('a devbox key exists; pass --rotate to replace it', { cause: err });
      throw err;
    }
    return;
  }
  const next = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(next, pem, { mode: 0o600, flag: 'wx' });
  fs.renameSync(next, file);
}

/** Resolves the exit code. @param {object} [deps] test seam {write} */
async function run(argv, { write = line => process.stdout.write(`${line}\n`) } = {}) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv, strict: true, allowPositionals: false,
      options: { dir: { type: 'string' }, rotate: { type: 'boolean' } }
    }));
  } catch {
    throw new Error('options are --dir <path> and --rotate');
  }
  const dir = values.dir || DEFAULT_DIR;
  keyDir(dir);
  const file = path.join(dir, KEY_FILE);
  const exists = fs.existsSync(file);
  if (!values.rotate && exists) throw new Error('a devbox key exists; pass --rotate to replace it');
  if (exists) publicLines(devboxKeysFromPem(fs.readFileSync(file, 'utf8')), 'old').forEach(write);
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: RSA_BITS });
  const ed = crypto.generateKeyPairSync('ed25519');
  const pem = pemOf(rsa.privateKey, 'pkcs8') + pemOf(ed.privateKey, 'pkcs8');
  // Read back through the loader's own parser, so a key it would refuse is never left on disk.
  const { fingerprint } = devboxKeysFromPem(pem);
  writeKey(file, pem, values.rotate === true);
  write(`keyFile=${file}`);
  write(pemOf(rsa.publicKey, 'spki').trim());
  write(pemOf(ed.publicKey, 'spki').trim());
  write(`fingerprint=${fingerprint}`);
  return 0;
}

module.exports = { run, KEY_FILE };

if (require.main === module) {
  run(process.argv.slice(2)).then(code => { process.exitCode = code; }, (err) => {
    logger.error('[works-import-key] failed', { error: err.message, stack: err.stack });
    process.exitCode = 1;
  });
}
