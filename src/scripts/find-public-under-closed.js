'use strict';

// Read only: finds documents and updates left public under a closed project. The repair is
// `runCascade(row, row.eagleId, options)` per printed project, with the printed options.

const cosmos = require('../db/cosmos-nosql');
const projects = require('../repositories/projects');
const documents = require('../repositories/documents');
const updates = require('../repositories/updates');
const notifications = require('../repositories/notifications');
const { isEagleOnlyProjectId } = require('../merge/project');
const { logger } = require('../utils/logger');

const TAG = '[public-under-closed]';
const USAGE = [
  'usage: node src/scripts/find-public-under-closed.js [--help]',
  'Lists documents and updates whose read holds `public` under a project whose read does not.',
  'Prints one JSON line per project {projectId, eagleId, twin, options, documents, updates}, then counts.',
  'Writes nothing. Exit 0 when clean, 1 when anything is found, 2 on an error.'
].join('\n');

const isPublic = (read) => Array.isArray(read) && read.includes('public');

function parseArgs(argv) {
  const args = { help: false };
  for (const a of argv) {
    if (a === '--help') args.help = true;
    else throw new Error(`${TAG} unknown argument: ${a}\n${USAGE}`);
  }
  return args;
}

function groupByEagleId(projectRows) {
  const groups = new Map();
  for (const row of projectRows) {
    if (!row.eagleId) continue;
    const key = String(row.eagleId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

const append = (map, key, value) => map.set(key, [...(map.get(key) || []), value]);

// Public updates by the DEMI id of a closed parent, as `update-parent:readParent` picks it: a notification
// owns its id (skipped), otherwise `pickByEagleId`, so a twin's updates follow its Track row.
function closedUpdateParents(updateRows, projectRows, notificationIds) {
  const byEagleId = groupByEagleId(projectRows);
  const flagged = new Map();
  for (const row of updateRows) {
    if (!row.projectId || !isPublic(row.read)) continue;
    const eagleId = String(row.projectId);
    if (notificationIds.has(eagleId)) continue;
    const parent = projects.pickByEagleId(byEagleId.get(eagleId), eagleId);
    if (parent && !isPublic(parent.read)) append(flagged, String(parent.id), String(row.id));
  }
  return flagged;
}

// A twin's updates belong to its Track row, as in seed-nosql's repayCascade.
function repairOptions(row, byEagleId) {
  if (!isEagleOnlyProjectId(row.id)) return {};
  const siblings = byEagleId.get(String(row.eagleId)) || [];
  return siblings.some(other => !isEagleOnlyProjectId(other.id)) ? { updates: false } : {};
}

/** One finding per project with a public document or update under it. */
function buildFindings({ projectRows, closedDocs, updateParents }) {
  const byEagleId = groupByEagleId(projectRows);
  return projectRows
    .filter(row => closedDocs.has(String(row.id)) || updateParents.has(String(row.id)))
    .map(row => ({
      projectId: String(row.id),
      eagleId: row.eagleId || null,
      twin: isEagleOnlyProjectId(row.id),
      options: repairOptions(row, byEagleId),
      documents: closedDocs.get(String(row.id)) || [],
      updates: updateParents.get(String(row.id)) || []
    }));
}

const spec = (query) => ({ query, parameters: [] });

async function loadProjects(query) {
  const { items } = await query(projects.CONTAINER,
    spec('SELECT c.id, c.eagleId, c.read, IS_OBJECT(c.sources.track) AS tracked FROM c'), {});
  return items.map(({ tracked, ...row }) => ({ ...row, sources: tracked ? { track: true } : {} }));
}

async function loadClosedDocs(query, projectRows) {
  const closedDocs = new Map();
  for (const row of projectRows.filter(r => !isPublic(r.read))) {
    const { items } = await query(documents.CONTAINER,
      spec("SELECT c.id FROM c WHERE ARRAY_CONTAINS(c.read, 'public')"), { partitionKey: String(row.id) });
    if (items.length > 0) closedDocs.set(String(row.id), items.map(item => String(item.id)));
  }
  return closedDocs;
}

/** @param {object} [deps] test seam: {query} */
async function find(deps = {}) {
  const query = deps.query || cosmos.query;
  const projectRows = await loadProjects(query);
  const closedDocs = await loadClosedDocs(query, projectRows);
  const { items: updateRows } = await query(updates.CONTAINER,
    spec("SELECT c.id, c.projectId, c.read FROM c WHERE ARRAY_CONTAINS(c.read, 'public')"), {});
  const { items: notificationRows } = await query(notifications.CONTAINER, spec('SELECT c.id FROM c'), {});
  const updateParents = closedUpdateParents(updateRows, projectRows,
    new Set(notificationRows.map(row => String(row.id))));
  return buildFindings({ projectRows, closedDocs, updateParents });
}

function report(findings) {
  for (const finding of findings) logger.info(`${TAG} ${JSON.stringify(finding)}`);
  const count = (key) => findings.reduce((sum, f) => sum + f[key].length, 0);
  logger.info(`${TAG} projects=${findings.length} documents=${count('documents')} updates=${count('updates')}`);
  return findings.length > 0 ? 1 : 0;
}

module.exports = { parseArgs, closedUpdateParents, buildFindings, find, report };

if (require.main === module) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    logger.error(err.message);
    process.exit(2);
  }
  if (args.help) {
    logger.info(USAGE);
    process.exit(0);
  }
  cosmos.initCosmosClient();
  find()
    .then(findings => process.exit(report(findings)))
    .catch((err) => {
      logger.error(`${TAG} ${err.stack || err.message}`);
      process.exit(2);
    });
}
