'use strict';

/** The nightly and poll runs over Track's project list; each row goes through `rowWriter`. */

const { systemAccess } = require('../helpers/access-sql');
const { isNativeProject } = require('../merge/project');
const { observeInvestment, pacificDay } = require('../domain/project-staff-fields');
const { clientToken, fetchTrackProjects } = require('../seed/sources');
const { HEAL_CAP, rowWriter, emptySummary, owesLink } = require('./sync-track-projects');
const config = require('../config');
const linksRepository = require('../repositories/links');
const { appendHistory, closeHistory } = require('../repositories/project-staff-history');
const { logger } = require('../utils/logger');

/** Write results that leave a row under the Track id, so its investment entries are this run's to keep. */
const ROW_WRITTEN = new Set(['created', 'relinked', 'updated', 'unchanged']);

/** Cosmos is private-endpoint-only, so a CLI dry run off-platform has no repository to ask. */
function projectsRepository() {
  if (process.env.COSMOS_ENDPOINT) return require('../repositories/projects');
  logger.warn('[track-projects] COSMOS_ENDPOINT not set: project sync reported as 0');
  return null;
}

/** The run-start lookups over every stored row. */
function indexStored(items) {
  const byEagleId = (keep) => new Map(items.filter(p => keep(p) && p.eagleId).map(p => [String(p.eagleId), p]));
  return {
    stored: new Map(items.map(p => [String(p.id), p])),
    // An Eagle-only row (`sourceSystem === 'eagle'`, as in `listEagleOnlyIds`) whose guid Track lists
    // is the same project under its pre-Track key, as `buildRegistry` matches on `epic_guid`.
    eagleOnly: byEagleId(p => p.sourceSystem === 'eagle'),
    // An Eagle-only row whose project now lives under a Track id is dead weight; its code moved too.
    rekeyed: new Set(items.filter(p => p.sourceSystem !== 'eagle' && p.eagleId).map(p => String(p.eagleId))),
    // A second row holding a native row's Eagle id makes the Eagle id lookup throw DUPLICATE_ID.
    nativeByEagleId: byEagleId(isNativeProject)
  };
}

/** The write `observeInvestment` asked for, or its status when it asked none; a dry run reports the live outcome. */
async function writeSeen(id, seen, live, stillDue) {
  const field = 'capitalInvestments';
  if (seen.status === 'append') {
    return live ? (await appendHistory(id, field, seen.append, seen.close, stillDue)).status : 'appended';
  }
  if (seen.status === 'empty' && seen.close) {
    return live ? (await closeHistory(id, field, seen.close.id, seen.close.effectiveTo)).status : 'closed';
  }
  return seen.status;
}

/**
 * Appends a `track` entry for Track's `capital_investment` and an `eagle` one for the row's `intake.investment`
 * when either moved, closing that source's open entry in the same patch; a cleared value only closes it.
 */
async function observeInvestments(apiProject, row, { live, runDate, summary }) {
  const id = String(apiProject.id);
  const counts = summary.investment;
  let full = false;
  for (const [source, value] of [['track', apiProject.capital_investment], ['eagle', row.intake?.investment]]) {
    const seen = observeInvestment(row.capitalInvestments, source, value, runDate);
    if (seen.status === 'unreadable') counts.unreadable++;
    // A run that overlaps this one may have appended the same move since the run-start read.
    const stillDue = (list) => observeInvestment(list, source, value, runDate).status === 'append';
    const status = await writeSeen(id, seen, live, stillDue);
    if (status === 'full') full = true;
    if (status === 'appended') counts.appended++;
    if (status === 'closed' || (status === 'appended' && seen.close)) counts.closed++;
    // The entries stay as they were, so the next run observes the same move again.
    if (['changed', 'absent', 'conflict', 'missing'].includes(status)) {
      summary.failures++;
      logger.error(`[investment] project ${id} ${source} entry not written`, { status });
    }
  }
  if (full) counts.full++;
}

/** The run's investment step and its log line; none when {enabled} is false, as the poll leaves it to the nightly. */
function investmentPass(enabled, { stored, eagleOnly, repo, live, runDate, summary }) {
  if (enabled === false) return { observe: null, report: () => {} };
  // A relink's row is new and carries the twin's entries and `intake`: read live, the run-start twin in a dry run.
  const relinkedRow = (apiProject, id) =>
    (live ? repo.getById(systemAccess(), id) : eagleOnly.get(String(apiProject.epic_guid)));
  const observe = async (apiProject, action) => {
    const id = String(apiProject.id);
    try {
      const row = stored.get(id) ?? (action === 'relinked' ? await relinkedRow(apiProject, id) : null) ?? {};
      await observeInvestments(apiProject, row, { live, runDate, summary });
    } catch (err) {
      summary.failures++;
      logger.error(`[investment] project ${id} failed`, { error: err.message, stack: err.stack });
    }
  };
  const report = () => {
    const { appended, closed, unreadable, full } = summary.investment;
    if (summary.trackProjects) logger.info(`[investment] appended=${appended} closed=${closed} unreadable=${unreadable} full=${full}`);
  };
  return { observe, report };
}

/** Writes every listed Track row; resolves the ids seen, the native clashes and the state moves. */
async function writeListed(rows, writer, { phases, works, nested, pushedAt, investment }, summary) {
  const listed = new Set();
  const nativeClashes = [];
  const stateMoves = new Map();
  for (const apiProject of rows) {
    const id = String(apiProject.id);
    listed.add(id);
    try {
      const result = await writer.write(apiProject,
        { phases: phases.get(id), works: works.get(id), nested: nested.get(id), pushedAt });
      if (result.reason === 'nativeClash') {
        nativeClashes.push({ trackProjectId: id, nativeId: result.nativeId, eagleId: result.eagleId });
      }
      if (result.stateMove) stateMoves.set(result.stateMove, (stateMoves.get(result.stateMove) || 0) + 1);
      if (investment && ROW_WRITTEN.has(result.action)) await investment(apiProject, result.action);
      if (result.action === 'failed') {
        summary.failures++;
        logger.error(`[track-projects] project ${id} not written`, { status: result.status });
      }
    } catch (err) {
      summary.failures++;
      logger.error(`[track-projects] project ${id} failed`, { error: err.message, stack: err.stack });
    }
  }
  return { listed, nativeClashes, stateMoves };
}

// `/projects` hides soft-deleted rows, so a Track delete that landed is not an orphan. A Track delete
// skips a row holding an Eagle copy, so that row stays live for good and is listed apart.
function reportUnlisted(stored, listed, summary, quiet) {
  const unlisted = [...stored].filter(([id, project]) =>
    !listed.has(id) && project.sourceSystem === 'track' && project.isDeleted !== true);
  const eagleLinked = ([, project]) => Boolean(project.sources && project.sources.eagle);
  const orphans = unlisted.filter(row => !eagleLinked(row)).map(([id]) => id);
  summary.orphaned = orphans.length;
  if (unlisted.length && !quiet) {
    logger.warn('[track-projects] DEMI rows Track no longer lists',
      { ids: orphans, eagleLinkedIds: unlisted.filter(eagleLinked).map(([id]) => id) });
  }
}

/** Heals, mints or migrates an Eagle-only row's code: no Track row names it, so no other pass does. */
async function upkeepEagleOnly(row, { writer, repo, live, summary }) {
  await writer.heal(row);
  if (!owesLink(row)) return;
  try {
    if (!live) {
      if (await writer.mint({ ...row })) summary.shortLinks++;
      return;
    }
    const written = await writer.writeMinting(row.id, row, async (current, mintRow) => {
      if (!current || !owesLink(current)) return { status: 'skipped' };
      const next = { ...current };
      const minted = await mintRow(next);
      // A patch of the three fields: nothing else on an Eagle-only row is this job's to write.
      await repo.patchShortLink(current.id, next, current._etag);
      return { status: 'saved', minted };
    });
    if (written.status === 'conflict') {
      summary.failures++;
      logger.error(`[track-projects] project ${row.id} short code not migrated`, { status: written.status });
    }
  } catch (err) {
    summary.failures++;
    logger.error(`[track-projects] project ${row.id} short code migration failed`, { error: err.message, stack: err.stack });
  }
}

/**
 * Mirrors raw `GET /api/v1/projects` rows. {skipLinkUpkeep} skips heal, slugs and the Eagle-only pass; {pushedAt} is epoch
 * ms before Track was read; {investment} false (the poll) leaves investment entries to the nightly.
 */
async function syncProjects(apiProjects, opts = {}) {
  const { live = false, deps = {}, skipLinkUpkeep = false, pushedAt = null } = opts;
  const now = opts.now || new Date().toISOString();
  const lists = { phases: opts.phases || new Map(), works: opts.works || new Map(), nested: opts.nested || new Map() };
  const rows = apiProjects || [];
  const summary = emptySummary(rows.length);

  const repo = deps.projects || projectsRepository();
  if (!repo) return summary;
  // systemAccess(), because a scoped context would list only what it can see and then create a
  // second copy of every record it was not shown.
  const { items } = await repo.listVisible(systemAccess(), {});
  const { stored, eagleOnly, rekeyed, nativeByEagleId } = indexStored(items);

  const writer = rowWriter({
    repo,
    links: deps.links || linksRepository,
    live,
    now,
    skipLinkUpkeep,
    summary,
    lookup: {
      stored: (id) => stored.get(id),
      eagleOnly: (guid) => eagleOnly.get(guid),
      native: (guid) => nativeByEagleId.get(guid)
    },
    onRelink: (relink) => rekeyed.add(String(relink.eagleId))
  });

  const investment = investmentPass(opts.investment, { stored, eagleOnly, repo, live, runDate: pacificDay(now), summary });
  const { listed, nativeClashes, stateMoves } = await writeListed(rows, writer,
    { ...lists, pushedAt, investment: investment.observe }, summary);
  investment.report();
  reportUnlisted(stored, listed, summary, skipLinkUpkeep);
  if (nativeClashes.length) {
    logger.warn('[track-projects] Track projects name the Eagle id of a native project; not created',
      { clashes: nativeClashes });
  }

  for (const row of skipLinkUpkeep ? [] : eagleOnly.values()) {
    if (!rekeyed.has(String(row.eagleId))) await upkeepEagleOnly(row, { writer, repo, live, summary });
  }

  if (writer.healLeftOver()) {
    logger.warn('[track-projects] heal cap reached, the rest wait for the next run', { cap: HEAL_CAP });
  }
  if (stateMoves.size) {
    logger.info(`[track-projects] projectState moves ${[...stateMoves].map(([move, n]) => `${move} x${n}`).join('; ')}`);
  }
  return summary;
}

const POLL_FIELDS = ['trackProjects', 'created', 'updated', 'relinked', 'skippedApiRows', 'orphaned',
  'shortLinks', 'nativeClash', 'held', 'stateMoved', 'failures'];

/** The line a log alert matches. A run that failed before the mirror reports its counts as 0. */
const pollLine = (s) => `[track-projects-poll] mode=${s.mode} ` +
  POLL_FIELDS.map(field => `${field}=${s[field] || 0}`).join(' ');

/**
 * The projects-only poll: one Track token, one `GET /api/v1/projects`, then the mirror.
 *
 * @param {object} [opts] {live} write, {deps} test seam {kc, fetchJson, projects, links}
 */
async function run({ live = false, deps = {} } = {}) {
  const kc = deps.kc || { clientToken };
  // Before the read: a push that lands after it holds a newer stamp, so this snapshot cannot overwrite it.
  const pushedAt = Date.now();
  let summary;
  try {
    const token = await kc.clientToken(config.trackClientId, config.trackClientSecret);
    const projects = await fetchTrackProjects(token, deps.fetchJson);
    summary = await syncProjects(projects, { live, deps, skipLinkUpkeep: true, pushedAt, investment: false });
  } catch (err) {
    logger.error('[track-projects-poll] run failed', { error: err.message, stack: err.stack });
    summary = { failures: 1 };
  }
  summary.mode = live ? 'live' : 'dry-run';
  logger.info(pollLine(summary));
  return summary;
}

module.exports = { syncProjects, run };
