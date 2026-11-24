'use strict';

const { redactForAccess, redactAllForAccess } = require('../../vis/redact');
const documentsRepo = require('../../repositories/documents');
const projectsRepo = require('../../repositories/projects');
const { EAGLE_OBJECT_ID } = projectsRepo;
const commentPeriodsRepo = require('../../repositories/comment-periods');
const notificationsRepo = require('../../repositories/notifications');
const listsRepo = require('../../repositories/lists');

/**
 * The eagle-search wire shape for a REDACTED Cosmos row. Spread on purpose: the catalog decides what
 * leaves, and a field list here would be a second policy. `_id` is the EAGLE id eagle-public keys on.
 */
function cosmosRows(entity, rows, access, schemaName, decorate) {
  return redactAllForAccess(entity, rows, access).map((row) => ({
    ...row,
    _id: String(row.eagleId || row.id),
    _schemaName: schemaName,
    ...(decorate ? decorate(row) : {})
  }));
}

// `listByIdsUnscoped` is cross-partition, so its caller keeps each read to this many ids.
const UPDATE_DOCUMENT_BATCH = 200;

/** The documents Update rows reference. No project ids to narrow by: an update may attach any. */
async function updateDocuments(access, ids) {
  const rows = [];
  for (let i = 0; i < ids.length; i += UPDATE_DOCUMENT_BATCH) {
    rows.push(...await documentsRepo.listByIdsUnscoped(
      access, ids.slice(i, i + UPDATE_DOCUMENT_BATCH), 'c.id, c.projectId, c.displayName, c.documentFileName, c.vis'
    ));
  }
  return rows;
}

/** An Update image as the News model reads it, its `document` already resolved for this caller. */
function imageOut(entry, document) {
  return { document, alt: entry.alt || '', caption: entry.caption || null, credit: entry.credit || null };
}

/** Redacted rows keyed on their STORED id, so a dialled `id` still joins. */
function byStoredId(entity, rows, access) {
  return new Map(rows.map(row => [String(row.id), redactForAccess(entity, row, access)]));
}

/**
 * Resolve update rows' projects and documents under the CALLER's access, one query per kind for the
 * page. `updates.projectId` holds the EAGLE id. Unreadable: project gives null, document drops out.
 */
async function updateProjects(access, rows) {
  const idsOf = (field) => Array.from(new Set(rows.map(r => r[field]).filter(Boolean).map(String)));
  const eagleIds = idsOf('projectId');
  const periodIds = idsOf('pcp');
  const notificationIds = idsOf('projectNotification');
  // Document ids are Eagle `_id`s on both sides: the document mirror keys its rows by them.
  const documentIds = Array.from(new Set(rows.flatMap(r => [
    ...(Array.isArray(r.attachments) ? r.attachments : []),
    ...(r.featuredImage && r.featuredImage.document ? [r.featuredImage.document] : []),
    ...(Array.isArray(r.images) ? r.images.map(image => image && image.document) : [])
  ]).filter(Boolean).map(String)));

  // Redacted before anything reads a field off them, like every other repository row on this route.
  const [projectRows, byPeriodId, byNotificationId, documentRefs] = await Promise.all([
    eagleIds.length ? projectsRepo.listByEagleIds(access, eagleIds) : [],
    periodIds.length ? commentPeriodsRepo.listByIds(access, periodIds) : [],
    notificationIds.length ? notificationsRepo.listByIds(access, notificationIds) : [],
    updateDocuments(access, documentIds)
  ]).then(([p, cp, n, d]) => [
    redactAllForAccess('projects', p, access),
    byStoredId('commentPeriods', cp, access),
    byStoredId('notifications', n, access),
    redactAllForAccess('documents', d, access)
  ]);

  const byEagleId = new Map(projectRows.map(p => [String(p.eagleId), p]));
  const byDocumentId = new Map(documentRefs.map(d => [String(d.id), d]));
  // `_id` beside `id`: eagle-public reads a document reference by `_id`, like every Eagle row.
  const documentRef = (id) => {
    const doc = byDocumentId.get(String(id));
    return doc
      ? { _id: String(doc.id), id: String(doc.id), displayName: doc.displayName || null,
        documentFileName: doc.documentFileName || null }
      : null;
  };

  return (row) => {
    const project = row.projectId ? byEagleId.get(String(row.projectId)) : null;
    const period = row.pcp ? byPeriodId.get(String(row.pcp)) : null;
    const notification = row.projectNotification
      ? byNotificationId.get(String(row.projectNotification))
      : null;

    // `pcp` and `projectNotification` are OBJECTS or absent, never the stored bare id: the News
    // template reads fields off them. Unresolved leaves `undefined`, which drops the key.
    const image = row.featuredImage && row.featuredImage.document
      ? documentRef(row.featuredImage.document)
      : null;
    return {
      // `location` on the wire, `address` at rest, as on the Project dataset.
      project: project
        ? { _id: String(project.eagleId), name: project.name, location: project.address || null }
        : null,
      ...(Array.isArray(row.attachments)
        ? { attachments: row.attachments.map(documentRef).filter(Boolean) }
        : {}),
      ...(row.featuredImage !== undefined ? { featuredImage: image ? imageOut(row.featuredImage, image) : null } : {}),
      // Order kept: it is the display order. A row from before the gallery answers no key.
      ...(Array.isArray(row.images)
        ? {
          images: row.images.flatMap((entry) => {
            const document = entry && entry.document ? documentRef(entry.document) : null;
            return document ? [imageOut(entry, document)] : [];
          })
        }
        : {}),
      // Dates as stored, ISO string or null, so a reader can tell an open period from a closed one.
      pcp: period
        ? {
          _id: period.id, isMet: period.isMet === true, metURL: period.metURL || '',
          dateStarted: period.dateStarted ?? null, dateCompleted: period.dateCompleted ?? null
        }
        : undefined,
      projectNotification: notification
        ? { _id: notification.id, name: notification.name }
        : undefined
    };
  };
}

/** Update rows as the RecentActivity dataset answers them. The parent gate is the repository's. */
async function updateResults(access, rows) {
  return cosmosRows('updates', rows, access, 'RecentActivity', await updateProjects(access, rows));
}

/**
 * The rows' DEMI parent projects, read and redacted under the caller's access, with each readable
 * one's Eagle id (null when it has none). An unreadable parent is absent from both.
 */
async function parentProjects(access, rows) {
  const demiIds = Array.from(new Set(rows.map(r => r.projectId).filter(Boolean).map(String)));
  const parentById = byStoredId('projects',
    demiIds.length ? await projectsRepo.listByIds(access, demiIds) : [], access);
  const eagleIdByDemiId = new Map(Array.from(parentById,
    ([id, p]) => [id, p.eagleId ? String(p.eagleId) : null]));
  return { demiIds, parentById, eagleIdByDemiId };
}

/**
 * A notification row carries `proponent` as a NAME: Eagle stores a name or an Organization id there,
 * and the page renders it as sent. An id that matches nothing stays as sent.
 */
async function notificationRows(access, rows) {
  const orgIds = Array.from(new Set(rows
    .map(r => r.proponent)
    .filter(value => value && EAGLE_OBJECT_ID.test(String(value)))
    .map(String)));
  const orgById = byStoredId('lists', orgIds.length
    ? await listsRepo.listByIds(access, orgIds, listsRepo.KINDS.ORGANIZATION)
    : [], access);

  return cosmosRows('notifications', rows, access, 'ProjectNotification',
    (row) => ({ proponent: orgById.get(String(row.proponent))?.name || row.proponent }));
}

/** A comment row carries `period` — eagle-public's Comment model reads it. */
function commentRows(access, rows) {
  return cosmosRows('comments', rows, access, 'Comment',
    (row) => ({ period: row.periodId ? String(row.periodId) : null }));
}

module.exports = {
  cosmosRows,
  byStoredId,
  updateProjects,
  updateResults,
  parentProjects,
  notificationRows,
  commentRows
};
