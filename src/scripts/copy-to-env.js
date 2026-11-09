'use strict';

// Usage: node src/scripts/copy-to-env.js --target <endpoint> [--containers a,b] [--checkpoint <file>] [--live]
// Run on the devbox: both accounts are private-endpoint-only, and the app identity needs a Cosmos data-plane role on the target.

const fs = require('fs');
const { CosmosClient } = require('@azure/cosmos');
const { createCredential } = require('../utils/azure-credential');

const DATABASE_ID = process.env.COSMOS_NOSQL_DATABASE || 'demi';
const PAGE_SIZE = 100;

// Cosmos system properties — upserting them to another account is at best ignored, at worst 400.
const SYSTEM_PROPS = ['_rid', '_self', '_etag', '_attachments', '_ts'];

function arg(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 && argv[i + 1] ? argv[i + 1] : fallback;
}

function parseArgs(argv) {
  return {
    target: arg(argv, 'target', ''),
    containers: arg(argv, 'containers', 'projects,documents,boundaries,chunks').split(','),
    checkpoint: arg(argv, 'checkpoint', './copy-checkpoint.json'),
    live: argv.includes('--live')
  };
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
  const { target, containers, checkpoint, live } = parseArgs(argv);
  // Thrown so callers can catch it; the script entry below prints err.message and exits 1.
  if (!target) throw new Error('Missing --target <endpoint>');
  if (!process.env.COSMOS_ENDPOINT) throw new Error('COSMOS_ENDPOINT not set');

  const sourceDb = makeClient(process.env.COSMOS_ENDPOINT).database(DATABASE_ID);
  const targetDb = makeClient(target).database(DATABASE_ID);

  for (const name of containers) {
    const src = sourceDb.container(name);
    const dst = targetDb.container(name);
    const srcCount = await count(src);
    const dstCount = await count(dst);
    console.log(`[${name}] source=${srcCount} target=${dstCount}`);
    if (!live) continue;
    if (dstCount >= srcCount) { console.log(`[${name}] already complete, skipping`); continue; }

    const state = loadCheckpoint(checkpoint);
    let copied = state[name]?.copied || 0;
    let continuationToken = state[name]?.token || undefined;

    while (true) {
      const iterator = src.items.query(
        { query: 'SELECT * FROM c' },
        { maxItemCount: PAGE_SIZE, continuationToken }
      );
      const page = await iterator.fetchNext();
      const rows = page.resources || [];
      for (const row of rows) {
        for (const p of SYSTEM_PROPS) delete row[p];
        await dst.items.upsert(row);
        copied++;
      }
      continuationToken = page.continuationToken;
      state[name] = { copied, token: continuationToken };
      saveCheckpoint(checkpoint, state);
      if (copied % 1000 < PAGE_SIZE) {
        console.log(`[${name}] ${copied}/${srcCount} @ ${new Date().toISOString()}`);
      }
      if (!page.hasMoreResults || !continuationToken) break;
    }
    console.log(`[${name}] done: copied=${copied} targetNow=${await count(dst)}`);
  }
}

module.exports = { main };

if (require.main === module) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
