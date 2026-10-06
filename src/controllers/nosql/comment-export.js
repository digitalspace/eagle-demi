'use strict';

/**
 * Comment export CSV — DEMI's answer to eagle-api's `GET /api/comment/export/{periodId}`.
 * Rows and fields come from the caller's own access, never from Eagle's `format` flag.
 */

const comments = require('../../repositories/comments');
const commentPeriods = require('../../repositories/comment-periods');
const projects = require('../../repositories/projects');
const documents = require('../../repositories/documents');
const { resolveAccess } = require('../../helpers/access-sql');
const { levelOf } = require('../../vis/level');
const { redactForAccess, redactAllForAccess } = require('../../vis/redact');
const { serverError } = require('../../helpers/response');
const { logger } = require('../../utils/logger');
const { toCsv, sendCsv } = require('../report');

/** Levels that get the staff columns: sysadmin 1 and staff 2. */
const STAFF_MAX_LEVEL = 2;

const STAFF_COLUMNS = [
  'Comment_No', 'Submitted', 'Author', 'Location', 'Comment', 'Attachments', 'Published', 'Status',
  'Rejected_Reason', 'Rejected_Notes', 'EAO_Notes', 'Project', 'PCP_Title', 'Export_Date', 'CACMember'
];

const PROPONENT_COLUMNS = [
  'Comment_No', 'Submitted', 'Author', 'Location', 'Comment', 'Attachments', 'Published', 'Pillar',
  'Project', 'PCP_Title', 'Export_Date', 'CACMember'
];

/** Free text a submitter or staff member typed, which a spreadsheet could run as a formula. */
const TEXT_COLUMNS = [
  'Author', 'Location', 'Comment', 'Rejected_Reason', 'Rejected_Notes', 'EAO_Notes', 'Project', 'PCP_Title'
];

/** `listByIds` builds one IN list per call; keep it bounded. */
const DOCUMENT_BATCH = 200;

/** `yyyy-MM-dd` in UTC, as eagle-api's `formatDate` wrote it on its UTC pods. */
function exportDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/** OWASP CSV-injection guard: a leading `'` keeps `=`, `+`, `-`, `@` text from evaluating. */
function inert(value) {
  return typeof value === 'string' && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** The attachment ids this caller may read, through the same row predicate as every read. */
async function readableDocumentIds(access, rows, projectId) {
  const ids = [...new Set(rows.flatMap(row => (Array.isArray(row.documents) ? row.documents : [])))];
  const readable = new Set();
  for (let i = 0; i < ids.length; i += DOCUMENT_BATCH) {
    const found = await documents.listByIds(access, ids.slice(i, i + DOCUMENT_BATCH), [projectId]);
    for (const doc of found) readable.add(String(doc.id));
  }
  return readable;
}

/** Absolute download link on the host the caller reached, as eagle-api built from its own. */
function linkBase(req) {
  const headers = req.headers || {};
  const proto = String(headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(headers['x-forwarded-host'] || headers.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}

function csvRow(comment, { readable, base, projectName, periodTitle, today }) {
  const links = (comment.documents || [])
    .filter(id => readable.has(String(id)))
    .map(id => `${base}/documents/${encodeURIComponent(id)}/download`);

  const row = {
    Comment_No: comment.commentId,
    Submitted: exportDate(comment.dateAdded),
    // eagle-api's exact string, in both formats. An attributed name survives redaction at level 4.
    Author: comment.isAnonymous === false ? comment.author : 'Anonymous',
    Location: comment.location,
    Comment: comment.comment,
    // eagle-api's csv-stringify JSON-encoded the link array; kept so existing sheets still parse.
    Attachments: JSON.stringify(links),
    Published: exportDate(comment.datePosted),
    Status: comment.eaoStatus,
    Rejected_Reason: comment.rejectedReason,
    Rejected_Notes: comment.rejectedNotes,
    EAO_Notes: comment.eaoNotes,
    // DEMI does not mirror Eagle's `pillars`; the column stays for the proponent layout.
    Pillar: null,
    Project: projectName,
    PCP_Title: periodTitle,
    Export_Date: today,
    // csv-stringify's boolean cast: '1' or empty.
    CACMember: comment.submittedCAC === true ? '1' : ''
  };
  for (const column of TEXT_COLUMNS) row[column] = inert(row[column]);
  return row;
}

/** `GET /commentperiods/:periodId/comments/export`. Staff columns at level 2 and below. */
exports.exportComments = async (req, res) => {
  const periodId = req.params && req.params.periodId;
  if (!periodId || typeof periodId !== 'string') {
    return res.status(400).json({ error: 'periodId is required' });
  }

  try {
    const access = resolveAccess(req);
    const level = levelOf(access);
    const staff = level <= STAFF_MAX_LEVEL;

    const stored = await commentPeriods.getById(access, periodId);
    if (!stored) return res.status(404).json({ error: 'Comment period not found' });
    const period = redactForAccess('commentPeriods', stored, access);
    const project = redactForAccess('projects', await projects.getById(access, stored.projectId), access);

    const rows = redactAllForAccess('comments',
      await comments.listEveryByPeriod(periodId, access), access)
      // eagle-api's proponent export held published comments only, whatever else the caller reads.
      .filter(row => staff || row.isPublished === true);

    const readable = await readableDocumentIds(access, rows, stored.projectId);
    const context = {
      readable,
      base: linkBase(req),
      projectName: project && project.name,
      periodTitle: period.instructions,
      today: exportDate(new Date())
    };

    const columns = staff ? STAFF_COLUMNS : PROPONENT_COLUMNS;
    const body = toCsv(columns, rows.map(row => csvRow(row, context)));
    logger.info('[comment-export] exported', {
      periodId, level, format: staff ? 'staff' : 'proponent', rows: rows.length
    });
    return sendCsv(res, 'export.csv', body);
  } catch (err) {
    return serverError(res, err, 'comment export failed');
  }
};

exports.STAFF_COLUMNS = STAFF_COLUMNS;
exports.PROPONENT_COLUMNS = PROPONENT_COLUMNS;
