'use strict';

/**
 * One project's stored summary. Dry run unless `--live`; `--section` merges one section; `--store`
 * uploads an `--out` file unchanged. Never hand-edit a record: only the generator runs the gates.
 */

const fs = require('fs');

const { generateProjectSummary, SECTIONS, QUIET_REASONS } = require('../ai/project-summary');
const { sourceFor } = require('../ai/project-summary-sources');
const config = require('../config');
const { logger } = require('../utils/logger');

function parseArgs(argv) {
  const args = { project: null, live: false, section: null, out: null, store: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (a === '--project') args.project = argv[++i];
    else if (a === '--section') args.section = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--store') args.store = argv[++i];
    else throw new Error(`[project-summary] unknown argument: ${a}`);
  }
  // Required, with no all-projects mode: a backfill is a different job with a different cost, and
  // one that starts by accident is 382 projects of model calls.
  if (!args.project) throw new Error('[project-summary] --project <id> is required');
  if (args.section && !SECTIONS.includes(args.section)) {
    throw new Error(`[project-summary] unknown section "${args.section}"; ` +
      `one of ${SECTIONS.join(', ')}`);
  }
  // `--store` generates nothing, so the generation flags would read as instructions this run is
  // going to ignore — on the one path that writes to the API.
  if (args.store && (args.live || args.section || args.out)) {
    throw new Error('[project-summary] --store uploads a file as it stands; ' +
      'it takes no --live, --section or --out');
  }
  return args;
}

/**
 * Fold a one-section run into the stored record. Citations are renumbered, not appended, so kept
 * sections still point at their own sources; `facts`, `usage` and cost describe this run.
 */
function mergeSection(stored, fresh, section) {
  if (!stored) return fresh;

  // Kept sections keep the stored sources. A record with another `sourceAccess` was built from a
  // wider document set, and merging into it would relabel the rest as public.
  if (stored.sourceAccess !== fresh.sourceAccess) {
    throw new Error(`[project-summary] stored record sourceAccess ` +
      `"${stored.sourceAccess}" is not this run's "${fresh.sourceAccess}"; ` +
      `regenerate the whole record instead of one section`);
  }

  const kept = { ...stored.sections, [section]: fresh.sections[section] };

  // Renumber every surviving section's citations into one list. A section keeps the sources it
  // cited; only their numbers change.
  const entries = [];
  const numberFor = (entry) => {
    const existing = entries.find(e => e.chunkId === entry.chunkId);
    if (existing) return existing.n;
    const next = { ...entry, n: entries.length + 1 };
    entries.push(next);
    return next.n;
  };

  const sourceFor_ = (name) => (name === section ? fresh : stored);
  const lookup = (name, n) => sourceFor_(name).citations.find(c => c.n === n);

  const renumber = (name, value) => {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map(v => renumber(name, v));
    if (typeof value !== 'object') return value;

    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = key === 'citations' && Array.isArray(inner)
        ? inner.map(n => lookup(name, n)).filter(Boolean).map(numberFor)
        : renumber(name, inner);
    }
    return out;
  };

  const sections = {};
  for (const [name, value] of Object.entries(kept)) sections[name] = renumber(name, value);

  // A section's null reason and pending document move with it, so the verdict line stays true after
  // a one-section run.
  const carry = (storedMap, freshMap) => {
    const out = { ...storedMap };
    const value = (freshMap || {})[section];
    if (value === undefined) delete out[section];
    else out[section] = value;
    return out;
  };
  const sectionErrors = carry(stored.sectionErrors, fresh.sectionErrors);
  const sectionSources = carry(stored.sectionSources, fresh.sectionSources);

  return {
    ...stored,
    generatedAt: fresh.generatedAt,
    model: fresh.model,
    pricedAs: fresh.pricedAs,
    promptVersion: fresh.promptVersion,
    usage: fresh.usage,
    estimatedCostCad: fresh.estimatedCostCad,
    facts: fresh.facts,
    sections,
    sectionErrors,
    sectionSources,
    citations: entries
  };
}

/**
 * The verdict line. Sections are named, not counted; `failed` has real errors, `absent` only
 * `QUIET_REASONS` (the registry has nothing there, not a failure to investigate).
 */
function summaryLine(record, live) {
  const filled = Object.entries(record.sections)
    .filter(([, v]) => v !== null && (!Array.isArray(v) || v.length > 0))
    .map(([k]) => k);
  const errors = Object.entries(record.sectionErrors || {});
  // Amendments join one reason per document ("no_text: a, b; not_json: c"): quiet only when every
  // part is, else a real parse failure lands under `absent`.
  const isQuiet = (reason) => String(reason).split(';')
    .every(part => QUIET_REASONS.includes((part.match(/[a-z_]+/) || [''])[0]));
  const failed = errors.filter(([, reason]) => !isQuiet(reason)).map(([k]) => k);
  // A section that rendered is not absent, even when amendments record `no_text` for some of its
  // documents.
  const absent = errors
    .filter(([name, reason]) => isQuiet(reason) && !filled.includes(name))
    .map(([k]) => k);

  return `[project-summary] project=${record.projectId} sections=${filled.join(',') || 'none'} ` +
    `failed=${failed.join(',') || 'none'} absent=${absent.join(',') || 'none'} ` +
    `citations=${record.citations.length} model=${record.model || 'none'} ` +
    `pricedAs=${record.pricedAs} tokens=${record.usage.promptTokens}/${record.usage.completionTokens} ` +
    `estimatedCostCad=${record.estimatedCostCad.toFixed(4)} stored=${live}`;
}

/**
 * Upload a record unchanged. The id check is the guard: `save` writes by the record's own `id`, so a
 * file from another project would land there under this `--project`'s ACL check.
 */
async function storeRecord(adapter, project, file) {
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));

  if (String(record.projectId) !== String(project) || String(record.id) !== String(project)) {
    throw new Error(`[project-summary] ${file} holds project ` +
      `${record.projectId} (id ${record.id}), not ${project}`);
  }

  await adapter.save(record);
  logger.info(summaryLine(record, true));
  return { record, stored: true, code: 0 };
}

async function run({ project, live = false, section = null, out = null, store = null,
  sources } = {}) {
  const adapter = sources || sourceFor();

  if (store) return storeRecord(adapter, project, store);

  const fresh = await generateProjectSummary(project, { sources: adapter, section });
  if (!fresh) {
    // Not a failure of generation — a configuration state, and the exit code says so.
    logger.error('[project-summary] SUMMARY_ENABLED is not true; nothing generated');
    return { record: null, stored: false, code: 2 };
  }

  const record = section
    ? mergeSection(await adapter.summary(project), fresh, section)
    : fresh;

  if (out) fs.writeFileSync(out, JSON.stringify(record, null, 2));
  else logger.info(JSON.stringify(record, null, 2));

  if (live) await adapter.save(record);
  logger.info(summaryLine(record, live));

  return { record, stored: live, code: 0 };
}

module.exports = { parseArgs, mergeSection, summaryLine, run };

if (require.main === module) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    logger.error(err.message);
    process.exit(1);
  }

  logger.info(args.store
    ? `[project-summary] storing ${args.store} as project ${args.project}, unchanged`
    : `[project-summary] provider=${config.projectSummaryProvider} ` +
      `maxChunks=${config.projectSummaryMaxChunks} live=${args.live}`);

  run(args)
    .then(({ code }) => { if (code !== 0) process.exit(code); })
    .catch(err => {
      logger.error(`[project-summary] ${err.stack || err.message}`);
      process.exit(1);
    });
}
