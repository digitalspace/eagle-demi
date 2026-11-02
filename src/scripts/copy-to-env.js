'use strict';

/**
 * Copy containers from THIS environment's Cosmos account to another environment's.
 *
 * Written for the dev → test (staging) migration: demi-cosmos-dev holds the only copy of the
 * extracted corpus, and the copy is the corpus-preservation prerequisite for tearing dev down.
 *
 * Where it runs: inside the SOURCE VNet, on the devbox via `demi-run`, detached with a log file
 * (same harness as seed-nosql.js — `demi-run` supplies the settings, and the heap ceiling is
 * whatever the VM size allows). Both accounts are keyless behind private endpoints, so the TARGET
 * account needs (1) a private endpoint reachable from the source VNet and (2) a Cosmos data-plane
 * role assignment for this app's identity. Both are temporary and torn down after the copy.
 *
 * Usage:
 *   node src/scripts/copy-to-env.js --target https://demi-cosmos-test.documents.azure.com:443/
 *     [--containers projects,documents,boundaries,chunks] [--checkpoint /home/copy-checkpoint.json]
 *     [--live]
 *
 * Without --live it connects, counts both sides per container, and exits — the same probe you run
 * afterwards to verify the copy landed.
 *
 * Resumable: the checkpoint file stores the source continuation token per container, so a killed
 * run restarts where it stopped rather than at zero. Upserts make replays harmless.
 */

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

/**
 * @param {string[]} [argv]
 * @param {object} [deps] test seam: {client: (endpoint) => CosmosClient-like}
 */
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

module.exports = { main, parseArgs };

if (require.main === module) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
