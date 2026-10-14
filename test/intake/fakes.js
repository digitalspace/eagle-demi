'use strict';

/**
 * In-memory stand-ins for the intake's three dependencies: the documents store, the intake
 * account's containers, and the object store. They keep state, so tests assert where bytes and
 * rows ended up rather than which calls were made.
 */

const { Readable } = require('node:stream');
const { logger } = require('../../src/utils/logger');

const ACCOUNT = 'demiintest';
const INTAKE_VARS = [
  'INTAKE_STORAGE_ACCOUNT', 'INTAKE_INCOMING_CONTAINER', 'INTAKE_QUARANTINE_CONTAINER',
  'INTAKE_QUARANTINE_CLIENT_ID', 'INTAKE_SWEEP_SCHEDULE', 'INTAKE_PENDING_TIMEOUT_HOURS'
];

/** Set the INTAKE_* settings for one test; anything not named is cleared. Restored after. */
function setIntakeEnv(t, values = { INTAKE_STORAGE_ACCOUNT: ACCOUNT }) {
  const saved = INTAKE_VARS.map(v => [v, process.env[v]]);
  for (const v of INTAKE_VARS) {
    if (values[v] === undefined) delete process.env[v];
    else process.env[v] = values[v];
  }
  t.after(() => {
    for (const [v, value] of saved) {
      if (value === undefined) delete process.env[v];
      else process.env[v] = value;
    }
  });
}

/** Rows by id. `settle` only lands on a pending row, as the real conditional patch does. */
function fakeStore(rows) {
  const byId = new Map(rows.map(r => [r.id, { ...r }]));
  return {
    rows: byId,
    async findById(id) { return byId.has(id) ? { ...byId.get(id) } : null; },
    async settle(row, fields) {
      const stored = byId.get(row.id);
      if (!stored || stored.scanStatus !== 'pending') return false;
      Object.assign(stored, fields);
      return true;
    },
    async listStalePending(cutoff) {
      return [...byId.values()].filter(r => r.scanStatus === 'pending' && r.createdAt < cutoff);
    }
  };
}

/** The intake account: `incoming` seeded with `{ id: { bytes, etag, contentType } }`. */
function fakeAccount(incoming = {}) {
  const containers = { incoming: new Map(Object.entries(incoming)), quarantine: new Map() };
  const client = {
    async statObject(key) {
      const blob = containers.incoming.get(key);
      return blob ? { size: blob.bytes.length, etag: blob.etag, contentType: blob.contentType || null } : null;
    },
    async getObjectStream(key) { return Readable.from([containers.incoming.get(key).bytes]); },
    async copyObject(src, dest, { destContainer } = {}) {
      containers[destContainer || 'incoming'].set(dest, containers.incoming.get(src));
      return {};
    },
    async removeObject(key) { containers.incoming.delete(key); }
  };
  return { containers, blobs: { staging: () => client, quarantine: () => client } };
}

/** The object store: what was written, keyed by object key. */
function fakeNrs() {
  const objects = new Map();
  return {
    objects,
    async putObjectStream(key, stream, contentType) {
      const parts = [];
      for await (const part of stream) parts.push(part);
      objects.set(key, { bytes: Buffer.concat(parts), contentType });
      return key;
    }
  };
}

/** Every logger call, by level, as `{ message, meta }`. */
function recordLogs(t) {
  const logs = { debug: [], info: [], warn: [], error: [] };
  for (const level of Object.keys(logs)) {
    t.mock.method(logger, level, (message, meta) => { logs[level].push({ message, meta }); });
  }
  logs.all = () => [...logs.debug, ...logs.info, ...logs.warn, ...logs.error];
  return logs;
}

module.exports = { ACCOUNT, setIntakeEnv, fakeStore, fakeAccount, fakeNrs, recordLogs };
