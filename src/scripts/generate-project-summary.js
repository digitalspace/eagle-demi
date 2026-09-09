'use strict';

/**
 * Generate one project's stored AI summary.
 *
 *   node src/scripts/generate-project-summary.js --project 272 [--live] [--section conditions]
 *                                               [--out record.json]
 *   node src/scripts/generate-project-summary.js --project 272 --store record.json
 *
 * Dry run by default: it prints the record and what it cost and writes NOTHING to the API. `--live`
 * and `--store` are the only things that store. That split matters because the record IS the page —
 * a bad generation that lands is visible to anyone who opens the project.
 *
 * `--section` regenerates ONE section and merges it into the stored record, leaving the others as
 * they are. That is what makes prompt tuning affordable: re-running conditions against Site C is
 * one model call, not eight. `--out` writes the dry-run record to a file so two runs can be
 * diffed.
 *
 * `--store` uploads a record `--out` already wrote, BYTE FOR BYTE: no generation, no merge, no
 * edit of any kind, and it refuses a file whose project is not `--project`. It exists because a
 * generation takes minutes while the staff token it was read with lasts five, so a good record can
 * be produced and then fail to land. Storing it is a retry of the upload, not a second chance to
 * change what is in it.
 *
 * NOTHING HERE EDITS A RECORD BY HAND. Every stored claim has to have come out of the generator,
 * over that project's own chunks, past the citation and number gates — a hand-edited record would
 * carry the same "AI-generated, cited" badge with none of that behind it. Tuning happens in
 * `project-summary-prompts.js` and in the code; the server re-checks the record's contract on the
 * way in either way.
 *
 * Reads and writes through the DEMI API (src/ai/project-summary-sources.js), because Cosmos and AI
 * Search are private-endpoint only and this runs from a workstation. Environment:
 *
 *   DEMI_API_URL              the API base that `/projects` and `/documents` hang off
 *   DEMI_TOKEN                a staff bearer token (or DEMI_API_KEY for the X-Api-Key header)
 *   SUMMARY_ENABLED=true      the same flag the query-time summariser reads
 *   PROJECT_SUMMARY_PROVIDER  `foundry` (default) or `ollama`
 *
 * Cost is ALWAYS reported at the Foundry rates, whichever provider ran — see `pricedAs` on the
 * record. A local run is free in cash; the figure is what the same work would cost deployed.
 */

const fs = require('fs');

const { generateProjectSummary, SECTIONS } = require('../ai/project-summary');
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
 * A one-section run folded into the record already stored.
 *
 * Only the named section and the citations it introduced move. `facts` come from the fresh run
 * because they are computed from the current document index and cost nothing; `usage` and the cost
 * describe THIS run, not the sum of every run the record has seen, so the number stays readable.
 *
 * Citations are RENUMBERED, not appended: the fresh section's numbers index its own list, and
 * concatenating the two lists would leave every untouched section pointing at the wrong source.
 */
function mergeSection(stored, fresh, section) {
  if (!stored) return fresh;

  // The sections that are NOT being regenerated keep the stored record's sources. A record that
  // does not assert the same source access was built from a wider set of documents, and merging
  // one fresh section into it would relabel the rest as public.
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
    citations: entries
  };
}

/**
 * The one line a run is judged on: what was produced, what it cost, and whether it was stored.
 *
 * Section names rather than a count, because "5 sections" and "the conditions section is null" are
 * different answers and only the second one says the generation went wrong.
 */
function summaryLine(record, live) {
  const filled = Object.entries(record.sections)
    .filter(([, v]) => v !== null && (!Array.isArray(v) || v.length > 0))
    .map(([k]) => k);

  return `[project-summary] project=${record.projectId} sections=${filled.join(',') || 'none'} ` +
    `citations=${record.citations.length} model=${record.model || 'none'} ` +
    `pricedAs=${record.pricedAs} tokens=${record.usage.promptTokens}/${record.usage.completionTokens} ` +
    `estimatedCostCad=${record.estimatedCostCad.toFixed(4)} stored=${live}`;
}

/**
 * Upload a record from disk exactly as it is.
 *
 * The id check is the whole guard: `save` addresses the record by its own `id`, so a file from
 * another project would be written to that project through this run's ACL check, under a `--project`
 * that says otherwise. Nothing else is inspected — the server's contract check is what judges the
 * record, and a second opinion here that disagreed with it would only be a way to be wrong twice.
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
