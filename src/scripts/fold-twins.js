'use strict';

/**
 * Folds each `eagle-<id>` twin into the Track row that holds its Eagle id (`foldTwin`). Dry run by default: prints
 * each changed field and the plan's SHA-256. `--live --expect-plan-sha256 <hex>` writes that plan under the rows' etags.
 */

const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { systemAccess } = require('../helpers/access-sql');
const { eagleOnlyProjectId } = require('../merge/project');
const { deriveInputs } = require('../domain/works-derive');
const { foldTwin, settleTwin } = require('./sync-track-projects');
const { logger } = require('../utils/logger');

const PAIR = /^(\d+):([0-9a-f]{24})$/i;
const SHA256 = /^[0-9a-f]{64}$/;

function parseArgs(argv) {
  const args = { live: false, pairs: null, expect: null };
  const once = (key, value) => {
    if (args[key] !== null) throw new Error(`[fold-twins] ${key} given twice`);
    args[key] = value;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (a === '--pairs') once('pairs', parsePairs(argv[++i]));
    else if (a === '--expect-plan-sha256') once('expect', String(argv[++i] || '').toLowerCase());
    else throw new Error(`[fold-twins] unknown argument: ${a}`);
  }
  if (!args.pairs) throw new Error('[fold-twins] --pairs <trackId:eagleId,...> is required');
  if (args.live ? !SHA256.test(args.expect || '') : args.expect !== null) {
    throw new Error('[fold-twins] --live and --expect-plan-sha256 <hex> from a dry run go together');
  }
  return args;
}

function parsePairs(text) {
  const pairs = String(text || '').split(',').filter(Boolean).map((one) => {
    const match = PAIR.exec(one.trim());
    if (!match) throw new Error(`[fold-twins] not a trackId:eagleId pair: ${one}`);
    return { trackId: match[1], eagleId: match[2].toLowerCase() };
  });
  const tracks = new Set(pairs.map(p => p.trackId));
  const eagles = new Set(pairs.map(p => p.eagleId));
  if (!pairs.length || tracks.size < pairs.length || eagles.size < pairs.length) {
    throw new Error('[fold-twins] --pairs needs at least one pair and no id twice');
  }
  return pairs;
}

const COSMOS_KEYS = new Set(['_rid', '_self', '_attachments', '_ts', '_etag', 'updatedAt']);
const changedFields = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])]
  .filter(key => !COSMOS_KEYS.has(key) && !isDeepStrictEqual(before[key], after[key])).sort();

/** One pair's fold as read now, or `{refused}` with the reason. */
async function planPair(repo, { trackId, eagleId }) {
  const trackRow = await repo.getById(systemAccess(), trackId);
  const twin = await repo.getById(systemAccess(), eagleOnlyProjectId(eagleId));
  const refused = (reason, fields) => ({ trackId, eagleId, refused: reason, ...(fields ? { fields } : {}) });
  if (!trackRow || !(trackRow.sources || {}).track) return refused('noTrackRow');
  // Track's merge writes `eagleId: null` until `epic_guid` is set in Track; folding before that splits the project.
  if (String(trackRow.eagleId).toLowerCase() !== eagleId) return refused('eagleIdUnset');
  if (!twin || twin.sourceSystem !== 'eagle') return refused('noTwin');
  const planned = (row, settled) => ({
    trackId, eagleId, row, twin: settled, rowFields: changedFields(trackRow, row), twinFields: changedFields(twin, settled)
  });
  if (twin.foldedInto !== undefined && String(twin.foldedInto) !== trackId) return refused('foldedElsewhere');
  // Staff own the Track row's DEMI fields after a fold, so a re-run carries nothing back and only settles the twin.
  if (twin.foldedInto !== undefined) return planned(trackRow, settleTwin(twin, trackId, trackRow));
  // A fold would carry one row's delete state onto the other: staff decide which stands first.
  if ((trackRow.isDeleted === true) !== (twin.isDeleted === true)) return refused('deleteMismatch');
  const fold = foldTwin(trackRow, twin, await deriveInputs(trackRow));
  if (fold.clash.length) return refused('clash', fold.clash);
  return planned(fold.row, fold.twin);
}

/** The hash a live run must be handed: it covers each row as it will be written, etag included. */
const planSha256 = (plans) => crypto.createHash('sha256')
  .update(JSON.stringify(plans.map(({ rowFields: _r, twinFields: _t, ...plan }) => plan))).digest('hex');

function logPlan(plan) {
  const pair = `${plan.trackId}:${plan.eagleId}`;
  if (plan.refused) {
    logger.warn(`[fold-twins] ${pair} refused=${plan.refused}${plan.fields ? ` fields=${plan.fields.join(',')}` : ''}`);
  } else {
    logger.info(`[fold-twins] ${pair} row=${plan.rowFields.join(',') || '-'} twin=${plan.twinFields.join(',') || '-'}`);
  }
}

/** The Track row, then the twin; a twin that fails after its row landed counts `partial`, which a re-run settles. */
async function writePlan(repo, plan, now, summary) {
  let step = 'Track row';
  try {
    if (plan.rowFields.length) await repo.upsert({ ...plan.row, updatedAt: now }, { etag: plan.row._etag });
    step = 'twin';
    if (plan.twinFields.length) await repo.upsert(plan.twin, { etag: plan.twin._etag });
    summary.written++;
  } catch (err) {
    const partial = step === 'twin' && plan.rowFields.length > 0;
    summary[partial ? 'partial' : 'failed']++;
    logger.error(`[fold-twins] ${plan.trackId}:${plan.eagleId} ${step} not written${partial ? ' after its Track row landed' : ''}`,
      { error: err.message, stack: err.stack });
  }
}

/** {deps} test seam: {projects, now}. Resolves the summary; nothing is written unless every pair folds cleanly. */
async function foldTwins(argv = [], deps = {}) {
  const args = parseArgs(argv);
  const repo = deps.projects || require('../repositories/projects');
  const plans = [];
  for (const pair of args.pairs) plans.push(await planPair(repo, pair));
  plans.forEach(logPlan);

  const sha = planSha256(plans);
  const folds = plans.filter(plan => !plan.refused && (plan.rowFields.length || plan.twinFields.length));
  const summary = {
    mode: args.live ? 'live' : 'dry-run', pairs: plans.length, folds: folds.length,
    refused: plans.filter(plan => plan.refused).length, planChanged: false, written: 0, partial: 0, failed: 0, planSha256: sha
  };
  if (args.live && !summary.refused) {
    summary.planChanged = sha !== args.expect;
    for (const plan of summary.planChanged ? [] : folds) await writePlan(repo, plan, deps.now || new Date().toISOString(), summary);
  }
  logger.info(`[fold-twins] mode=${summary.mode} pairs=${summary.pairs} folds=${summary.folds} refused=${summary.refused} ` +
    `planChanged=${summary.planChanged} written=${summary.written} partial=${summary.partial} failed=${summary.failed} ` +
    `planSha256=${sha}`);
  return summary;
}

const exitCodeFor = (summary) => (summary.refused || summary.planChanged || summary.partial || summary.failed ? 1 : 0);

module.exports = { foldTwins, parseArgs, exitCodeFor };

if (require.main === module) {
  foldTwins(process.argv.slice(2))
    .then(summary => process.exit(exitCodeFor(summary)))
    .catch((err) => {
      logger.error(`[fold-twins] ${err.stack || err.message}`);
      process.exit(1);
    });
}
