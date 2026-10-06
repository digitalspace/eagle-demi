'use strict';

/**
 * CSV reports, DEMI's answer to eagle-api's `GET /api/reports?type=<type>`. `bcgw` is public
 * whoever asks: it reads with anonymous access, as eagle-api's `published: true` filter did.
 */

const projects = require('../repositories/projects');
const config = require('../config');
const { resolveAccess, MAX_PAGE_SIZE, MAX_PAGE_DEPTH } = require('../helpers/access-sql');
const { redactAllForAccess } = require('../vis/redact');
const { serverError } = require('../helpers/response');
const { logger } = require('../utils/logger');

/** Stop rule for the project walk: `readPage` refuses a page past MAX_PAGE_DEPTH anyway. */
const MAX_PAGES = Math.floor(MAX_PAGE_DEPTH / MAX_PAGE_SIZE);

/** One field, quoted only when it holds a quote, comma or line break: what csv-stringify does. */
function csvField(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Header plus one line per row, each `\n`-terminated, as eagle-api's csv-stringify wrote them. */
function toCsv(columns, rows) {
  const lines = [columns.map(csvField).join(',')];
  for (const row of rows) lines.push(columns.map(column => csvField(row[column])).join(','));
  return `${lines.join('\n')}\n`;
}

/** Sends a CSV body as a download. */
function sendCsv(res, filename, body) {
  res.set('content-type', 'text/csv; charset=utf-8');
  res.set('content-disposition', `attachment; filename=${filename}`);
  return res.status(200).send(body);
}

const BCGW_COLUMNS = [
  'Latitude', 'Longitude', 'Project name', 'Proponent', 'Type', 'Sub-Type', 'Description',
  'MOE Region', 'Project Phase', 'Legislation', 'Federal Involvement', 'EA Decision',
  'Decision Date', 'URL to Epic Project', 'Project GUID'
];

const OBJECT_ID = /^[0-9a-f]{24}$/i;

/** The label of an Eagle List ref, which the push sends resolved as `{_id, name}`. */
function refName(value) {
  if (value && typeof value === 'object') return value.name ?? null;
  // A bare id the push could not resolve: eagle-api's $lookup found nothing for it either.
  if (typeof value === 'string' && !OBJECT_ID.test(value)) return value;
  return null;
}

/** `MM-dd-yyyy` in UTC, the zone eagle-api's pods format in. */
function bcgwDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const pad = n => String(n).padStart(2, '0');
  return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}-${date.getUTCFullYear()}`;
}

/** One redacted project as the BCGW row eagle-api built from `read_only__reports__project_info`. */
function bcgwRow(project) {
  const coordinates = project.centroid && Array.isArray(project.centroid.coordinates)
    ? project.centroid.coordinates : [];
  const eagleId = project.eagleId || project.id;
  return {
    'Latitude': coordinates[1],
    'Longitude': coordinates[0],
    'Project name': project.name,
    'Proponent': project.proponentName,
    'Type': project.projectType,
    // eagle-api's view sets subType from `sector`, not from a sub-type field.
    'Sub-Type': project.sector,
    'Description': project.description,
    'MOE Region': project.region,
    'Project Phase': refName(project.currentPhaseName),
    'Legislation': project.legislation,
    'Federal Involvement': refName(project.CEAAInvolvement),
    'EA Decision': refName(project.eacDecision),
    'Decision Date': bcgwDate(project.decisionDate),
    'URL to Epic Project': `${config.linkBaseUrl}/p/${eagleId}/project-details`,
    // eagle-api JSON-stringified the ObjectId, so the warehouse has always ingested it in quotes.
    'Project GUID': JSON.stringify(String(eagleId))
  };
}

/** Every project anonymous access can read, page by page through the repository. */
async function listPublicProjects(access) {
  const rows = [];
  for (let pageNum = 0; pageNum < MAX_PAGES; pageNum++) {
    const page = await projects.listPage(access, { pageNum, pageSize: MAX_PAGE_SIZE });
    for (const row of page) rows.push(row);
    if (page.length < MAX_PAGE_SIZE) return rows;
  }
  logger.warn('[report] project walk hit its page bound; the report is truncated', { rows: rows.length });
  return rows;
}

async function bcgwReport() {
  // Anonymous on purpose: the report is the public field set of public rows, whoever asks.
  const access = resolveAccess({});
  const visible = redactAllForAccess('projects', await listPublicProjects(access), access);
  return toCsv(BCGW_COLUMNS, visible.map(bcgwRow));
}

const REPORTS = { bcgw: bcgwReport };

/** `GET /reports?type=bcgw`. Same 400s as eagle-api for a missing or unknown type. */
exports.getReport = async (req, res) => {
  const type = req.query && req.query.type;
  if (!type) return res.status(400).json({ error: 'Missing report type' });
  if (typeof type !== 'string' || !Object.hasOwn(REPORTS, type)) {
    return res.status(400).json({ error: 'Invalid report type' });
  }

  try {
    const body = await REPORTS[type]();
    logger.info('[report] generated', { type, bytes: Buffer.byteLength(body) });
    return sendCsv(res, `export_${type}.csv`, body);
  } catch (err) {
    return serverError(res, err, `report ${type} failed`);
  }
};

exports.BCGW_COLUMNS = BCGW_COLUMNS;
exports.toCsv = toCsv;
exports.sendCsv = sendCsv;
