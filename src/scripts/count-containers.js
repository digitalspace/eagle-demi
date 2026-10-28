'use strict';

// Read-only Cosmos counts as one JSON line, run on the devbox before and after a re-seed.
// Usage: node src/scripts/count-containers.js [--keep-ids FILE]; exits 1 when any read fails.

const fs = require('fs');
const cosmos = require('../db/cosmos-nosql');
const { logger } = require('../utils/logger');
const { parseKeepIds } = require('../utils/keep-ids');

const COUNTED = [
  'projects', 'documents', 'chunks', 'updates', 'commentPeriods', 'comments',
  'notifications', 'lists', 'boundaries', 'projectSummaries', 'links'
];
const INDEXED = ['chunks', 'documents', 'projects'];
// Keeps the line well under 4 KB when a whole SDK error body comes back.
const ERROR_CHARS = 120;

const spec = (query, params = {}) => ({
  query,
  parameters: Object.entries(params).map(([name, value]) => ({ name: `@${name}`, value }))
});

function parseArgs(argv) {
  const args = { keepIdsFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep-ids') {
      args.keepIdsFile = String(argv[++i] || '');
      if (!args.keepIdsFile) throw new Error('[count-containers] --keep-ids needs a file');
    } else {
      throw new Error(`[count-containers] unknown argument: ${a}`);
    }
  }
  return args;
}

async function countContainers(args, deps = {}) {
  const db = deps.cosmos || cosmos;
  const readFile = deps.readFile || (file => fs.readFileSync(file, 'utf8'));
  const keepIds = args.keepIdsFile ? parseKeepIds(readFile(args.keepIdsFile)) : [];

  const errors = {};
  const attempt = async (key, read) => {
    try {
      return await read();
    } catch (err) {
      errors[key] = String(err && err.message).slice(0, ERROR_CHARS);
      return null;
    }
  };

  const out = { counts: {}, projectsBySourceSystem: null, indexProgress: {}, keep: [] };

  for (const name of COUNTED) {
    out.counts[name] = await attempt(`counts.${name}`,
      () => db.queryValue(name, spec('SELECT VALUE COUNT(1) FROM c')));
  }

  out.projectsBySourceSystem = await attempt('projectsBySourceSystem', async () => {
    const { items } = await db.query('projects',
      spec('SELECT c.sourceSystem, COUNT(1) AS n FROM c GROUP BY c.sourceSystem'));
    return Object.fromEntries(items.map(row => [row.sourceSystem ?? 'none', row.n]));
  });

  for (const name of INDEXED) {
    out.indexProgress[name] = await attempt(`indexProgress.${name}`, () => db.indexProgress(name));
  }

  for (const id of keepIds) {
    const entry = { id, rowId: null, sourceSystem: null, trackProjectId: null, tags: null, documents: null };
    await attempt(`keep.${id}`, async () => {
      const { items } = await db.query('projects', spec(
        'SELECT c.id, c.sourceSystem, c.trackProjectId, c.tags FROM c WHERE c.id = @id OR c.eagleId = @id',
        { id }));
      const row = items[0];
      if (!row) {
        entry.missing = true;
        return;
      }
      Object.assign(entry, {
        rowId: row.id,
        sourceSystem: row.sourceSystem ?? null,
        trackProjectId: row.trackProjectId ?? null,
        tags: row.tags ?? null
      });
      entry.documents = await db.queryValue('documents',
        spec('SELECT VALUE COUNT(1) FROM c WHERE c.projectId = @p', { p: row.id }),
        { partitionKey: row.id });
    });
    out.keep.push(entry);
  }

  if (Object.keys(errors).length) out.errors = errors;
  return out;
}

/** @returns {Promise<number>} the exit code */
async function main(argv, deps = {}) {
  const write = deps.write || (line => process.stdout.write(line));
  const out = await countContainers(parseArgs(argv), deps);
  write(`${JSON.stringify(out)}\n`);
  return out.errors ? 1 : 0;
}

module.exports = { COUNTED, INDEXED, parseArgs, parseKeepIds, countContainers, main };

if (require.main === module) {
  // Unconfigured, every read answers empty and the line would look like an empty database.
  if (!cosmos.initCosmosClient()) process.exit(1);
  main(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch(err => {
      logger.error(`[count-containers] ${err.stack || err.message}`);
      process.exit(1);
    });
}
