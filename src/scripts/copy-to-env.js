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
const { DefaultAzureCredential } = require('@azure/identity');

const DATABASE_ID = process.env.COSMOS_NOSQL_DATABASE || 'demi';
const PAGE_SIZE = 100;

// Cosmos system properties — upserting them to another account is at best ignored, at worst 400.
const SYSTEM_PROPS = ['_rid', '_self', '_etag', '_attachments', '_ts'];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const TARGET = arg('target', '');
const CONTAINERS = arg('containers', 'projects,documents,boundaries,chunks').split(',');
const CHECKPOINT = arg('checkpoint', './copy-checkpoint.json');
const LIVE = process.argv.includes('--live');

function client(endpoint) {
  const credentialOptions = process.env.AZURE_CLIENT_ID
    ? { managedIdentityClientId: process.env.AZURE_CLIENT_ID }
    : undefined;
  return new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential(credentialOptions) });
}

function loadCheckpoint() {
  try { return JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8')); } catch { return {}; }
}

function saveCheckpoint(state) {
  fs.writeFileSync(CHECKPOINT, JSON.stringify(state));
}

async function count(container) {
  const { resources } = await container.items
    .query({ query: 'SELECT VALUE COUNT(1) FROM c' })
    .fetchAll();
  return resources[0];
}

async function main() {
  if (!TARGET) { console.error('Missing --target <endpoint>'); process.exit(1); }
  if (!process.env.COSMOS_ENDPOINT) { console.error('COSMOS_ENDPOINT not set'); process.exit(1); }

  const sourceDb = client(process.env.COSMOS_ENDPOINT).database(DATABASE_ID);
  const targetDb = client(TARGET).database(DATABASE_ID);

  for (const name of CONTAINERS) {
    const src = sourceDb.container(name);
    const dst = targetDb.container(name);
    const srcCount = await count(src);
    const dstCount = await count(dst);
    console.log(`[${name}] source=${srcCount} target=${dstCount}`);
    if (!LIVE) continue;
    if (dstCount >= srcCount) { console.log(`[${name}] already complete, skipping`); continue; }

    const state = loadCheckpoint();
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
      saveCheckpoint(state);
      if (copied % 1000 < PAGE_SIZE) {
        console.log(`[${name}] ${copied}/${srcCount} @ ${new Date().toISOString()}`);
      }
      if (!page.hasMoreResults || !continuationToken) break;
    }
    console.log(`[${name}] done: copied=${copied} targetNow=${await count(dst)}`);
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
