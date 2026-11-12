'use strict';

// Shared set-up for the works extract tests: temp folders, a fake keyring and devbox keys.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('../../../scripts/works-import/extract');
const { fingerprintOf, openExtract } = require('../../../src/utils/import-envelope');

const EXTRACT = path.join(__dirname, '../../../scripts/works-import/extract.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'works-extract-'));
const sheetsDir = path.join(tmp, 'sheets');
const throwaway = (length = 40) => crypto.randomBytes(length).toString('hex').slice(0, length);
const secrets = { surrogate: throwaway(), operator: throwaway(), short: throwaway(19), other: throwaway() };
let n = 0;
const fresh = (name) => {
  n += 1;
  const dir = path.join(tmp, `${name}-${n}`);
  fs.mkdirSync(dir);
  return dir;
};
const copyOfSheets = () => {
  const dir = fresh('sheets');
  fs.cpSync(sheetsDir, dir, { recursive: true });
  return dir;
};
const modeOf = file => fs.statSync(file).mode & 0o777;

// A stand-in for `secret-tool lookup service <s> account <ref>`: the account is the fifth argument.
function fakeKeyring() {
  const bin = fresh('bin');
  const cases = Object.entries(secrets).map(([ref, value]) => `  ${ref}) printf '%s\\n' '${value}' ;;`).join('\n');
  const script = `#!/bin/sh\ncase "$5" in\n${cases}\n  *) exit 1 ;;\nesac\n`;
  for (const name of ['secret-tool', 'security']) fs.writeFileSync(path.join(bin, name), script, { mode: 0o700 });
  return { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
}
const env = fakeKeyring();

function devboxKeys() {
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
  const ed = crypto.generateKeyPairSync('ed25519');
  const pemFile = path.join(fresh('devbox'), 'devbox.pub.pem');
  fs.writeFileSync(pemFile, [rsa.publicKey, ed.publicKey].map(k => k.export({ type: 'spki', format: 'pem' })).join(''));
  return { rsa, ed, pemFile, fingerprint: fingerprintOf({ rsa: rsa.publicKey, ed25519: ed.publicKey }) };
}
const devbox = devboxKeys();

async function cli(argv, cliEnv = env) {
  const lines = [];
  await run(argv, { env: cliEnv, write: line => lines.push(line) });
  return lines;
}

async function extractTo(args, keys = devbox, out = path.join(fresh('out'), 'extract.sealed.json')) {
  const lines = await cli(['extract', '--in', sheetsDir, '--recipient-key', keys.pemFile,
    '--expect-fingerprint', keys.fingerprint, '--out', out, ...args]);
  const sealed = fs.readFileSync(out);
  const opened = openExtract(sealed, { env: args[args.indexOf('--env') + 1], keyFingerprint: keys.fingerprint, privateKey: keys.rsa.privateKey });
  return { out, lines, sealed, ...opened };
}

const newMap = () => path.join(fresh('map'), 'surrogates.enc.json');
const surrogateArgs = (file, ...extra) => ['--surrogates', file, '--surrogate-passphrase-ref', 'surrogate', ...extra];

module.exports = {
  EXTRACT, tmp, sheetsDir, secrets, fresh, copyOfSheets, modeOf, devboxKeys, devbox, cli, extractTo, newMap, surrogateArgs
};
