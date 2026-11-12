'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SURROGATE_AAD = Buffer.from('works-import-surrogates');
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const surrogateKey = (passphrase, salt) => crypto.scryptSync(passphrase, salt, 32, SCRYPT);

function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function heldMessage(lockFile) {
  const pid = Number.parseInt(readOrNull(lockFile), 10);
  const stale = Number.isInteger(pid) && pid > 0 && !running(pid) ? `; process ${pid} named in it is not running` : '';
  return `${lockFile} exists: another run holds the surrogate map. Delete it only when no run is active${stale}`;
}

/** Takes `<map>.lock` with an exclusive create; the returned release removes it only while it holds this PID. */
function lock(file) {
  const lockFile = `${file}.lock`;
  const mine = String(process.pid);
  try {
    fs.writeFileSync(lockFile, mine, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    throw new Error(err.code === 'EEXIST' ? heldMessage(lockFile) : `${lockFile} cannot be created`, { cause: err });
  }
  const onSignal = (signal) => {
    release();
    process.kill(process.pid, signal);
  };
  function release() {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (readOrNull(lockFile) === mine) fs.rmSync(lockFile, { force: true });
  }
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return release;
}

function load(file, passphrase) {
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

function sealMap(map, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', surrogateKey(passphrase, salt), iv, { authTagLength: 16 });
  cipher.setAAD(SURROGATE_AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify([...map])), cipher.final()]);
  return JSON.stringify({
    v: 1, salt: salt.toString('base64'), iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64')
  });
}

/** Writes and fsyncs a temp file, then renames it over the map, or links it as a new map that must not exist yet. */
function save(file, map, passphrase, replace) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    try {
      fs.writeSync(fd, sealMap(map, passphrase));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (replace) {
      fs.renameSync(tmp, file);
      return;
    }
    try {
      fs.linkSync(tmp, file);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      throw new Error(`surrogate map ${file} appeared during this run; it was left unchanged`, { cause: err });
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Locks, then opens the surrogate map. A missing map is refused unless `create`: a fresh map re-mints
 * every surrogate, and the next load tombstones and re-creates every test sheet work.
 */
function openSurrogates(file, { create, readPassphrase }) {
  const release = lock(file);
  try {
    const exists = fs.existsSync(file);
    if (!exists && !create) {
      throw new Error(`surrogate map ${path.resolve(file)} not found. Pass --new-surrogates only on the very first run; otherwise fix --surrogates`);
    }
    if (exists && create) throw new Error(`surrogate map ${file} exists; drop --new-surrogates`);
    const passphrase = readPassphrase();
    const map = exists ? load(file, passphrase) : new Map();
    return { map, release, save: () => save(file, map, passphrase, exists) };
  } catch (err) {
    release();
    throw err;
  }
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

module.exports = { openSurrogates, surrogateOf };
