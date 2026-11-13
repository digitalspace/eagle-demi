'use strict';

// Usage: node src/scripts/copy-to-env.js --target <endpoint> [--containers a,b] [--checkpoint <file>] [--keep-staff <signoff-ref>] [--live]
// Run on the devbox: both accounts are private-endpoint-only, and the app identity needs a Cosmos data-plane role on the target.

const fs = require('fs');
const { CosmosClient } = require('@azure/cosmos');
const { createCredential } = require('../utils/azure-credential');
const { ENTRY_SCHEMAS } = require('../domain/project-staff-fields');
const { LEGISLATION_KEY } = require('../ownership/project');
const { logger } = require('../utils/logger');

const DATABASE_ID = process.env.COSMOS_NOSQL_DATABASE || 'demi';
const PAGE_SIZE = 100;

// Cosmos system properties — upserting them to another account is at best ignored, at worst 400.
const SYSTEM_PROPS = ['_rid', '_self', '_etag', '_attachments', '_ts'];
// Works and import bookkeeping stay in the environment that loaded them: a marker copied alone would hide Track works.
const REFUSED_CONTAINERS = new Set(['works']);
const REFUSED_LIST_KINDS = new Set(['ImportBatch', 'ImportBatchEntry', 'ImportLock']);
const STAFF_ONLY_FIELDS = Object.keys(ENTRY_SCHEMAS);

/** Drops staff-only lists and every `intake` copy from a projects row, in place. */
function stripStaff(row) {
  for (const doc of [row, row.sources && row.sources.eagle]) {
    if (!doc || typeof doc !== 'object') continue;
    for (const field of STAFF_ONLY_FIELDS) delete doc[field];
    delete doc.intake;
    for (const [key, block] of Object.entries(doc)) {
      if (LEGISLATION_KEY.test(key) && block && typeof block === 'object') delete block.intake;
    }
  }
}

/** The row to upsert, or null when it must not leave this environment. */
function rowFor(name, row, keepStaff) {
  if (name === 'lists' && REFUSED_LIST_KINDS.has(row.kind)) return null;
  for (const p of SYSTEM_PROPS) delete row[p];
  if (name === 'projects' && !keepStaff) stripStaff(row);
  return row;
}

function arg(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}

function parseArgs(argv) {
  return {
    target: arg(argv, 'target', ''),
    containers: arg(argv, 'containers', 'projects,documents,boundaries,chunks').split(','),
    checkpoint: arg(argv, 'checkpoint', './copy-checkpoint.json'),
    keepStaff: arg(argv, 'keep-staff', ''),
    live: argv.includes('--live')
  };
}

// Thrown so callers can catch it; the script entry below logs err.message and exits 1.
function checkedArgs(argv) {
  const args = parseArgs(argv);
  if (!args.target) throw new Error('Missing --target <endpoint>');
  if (!process.env.COSMOS_ENDPOINT) throw new Error('COSMOS_ENDPOINT not set');
  // No sign-off ref format exists elsewhere, so one token with no spaces is the rule.
  if (argv.includes('--keep-staff') && !/^\S+$/.test(args.keepStaff)) throw new Error('--keep-staff needs a sign-off reference');
  const refused = args.containers.filter(name => REFUSED_CONTAINERS.has(name));
  if (refused.length) throw new Error(`Refusing to copy container ${refused.join(',')}`);
  if (args.keepStaff) logger.warn(`[copy-to-env] keeping staff-only project fields under sign-off ${args.keepStaff}`);
  return args;
}

function client(endpoint) {
  return new CosmosClient({ endpoint, aadCredentials: createCredential() });
}

function loadCheckpoint(path) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return {}; }
}

function saveCheckpoint(path, state) {
  fs.writeFileSync(path, JSON.stringify(state));
}

async function count(container) {
  const { resources } = await container.items
    .query({ query: 'SELECT VALUE COUNT(1) FROM c' })
    .fetchAll();
  return resources[0];
}

// argv and deps are injectable so tests can run main() without Cosmos.
async function main(argv = process.argv.slice(2), deps = {}) {
  const makeClient = deps.client || client;
  const { target, containers, checkpoint, keepStaff, live } = checkedArgs(argv);

  const sourceDb = makeClient(process.env.COSMOS_ENDPOINT).database(DATABASE_ID);
  const targetDb = makeClient(target).database(DATABASE_ID);

  for (const name of containers) {
    const src = sourceDb.container(name);
    const dst = targetDb.container(name);
    const srcCount = await count(src);
    const dstCount = await count(dst);
    logger.info(`[copy-to-env] [${name}] source=${srcCount} target=${dstCount}`);
    if (!live) continue;
    if (dstCount >= srcCount) { logger.info(`[copy-to-env] [${name}] already complete, skipping`); continue; }

    const state = loadCheckpoint(checkpoint);
    let copied = state[name]?.copied || 0;
    let continuationToken = state[name]?.token || undefined;
    let refusedRows = 0;

    while (true) {
      const iterator = src.items.query(
        { query: 'SELECT * FROM c' },
        { maxItemCount: PAGE_SIZE, continuationToken }
      );
      const page = await iterator.fetchNext();
      const rows = page.resources || [];
      for (const row of rows) {
        const copy = rowFor(name, row, keepStaff);
        if (copy) await dst.items.upsert(copy);
        else refusedRows++;
        copied++;
      }
      continuationToken = page.continuationToken;
      state[name] = { copied, token: continuationToken };
      saveCheckpoint(checkpoint, state);
      if (copied % 1000 < PAGE_SIZE) {
        logger.info(`[copy-to-env] [${name}] ${copied}/${srcCount} @ ${new Date().toISOString()}`);
      }
      if (!page.hasMoreResults || !continuationToken) break;
    }
    logger.info(`[copy-to-env] [${name}] done: read=${copied} refused=${refusedRows} targetNow=${await count(dst)}`);
  }
}

module.exports = { main };

if (require.main === module) {
  main().catch((err) => { logger.error(`[copy-to-env] ${err.message}`); process.exitCode = 1; });
}
