'use strict';

// An organization has no parent project, so its own `read[]` is the whole ACL. Pinned proponents
// are gated by each project's `pinsRead[]` instead (`pinsPublished`).

const lists = require('../../repositories/lists');
const { eagleBaseAcl } = require('../../seed/transform');
const { mirrorError } = require('../../helpers/duplicate-id');
const { auditEvent } = require('../../utils/audit');
const { DEMI_OWNED_FIELDS } = require('../../ownership/organization');
const {
  eaglePush, upsertKeepingDemiRows, ignoreStalePush, pushConflict
} = require('./eagle-mirror');

/** Eagle's staff-side organization fields. Also what src/scripts/backfill-eagle-staff-fields.js copies. */
function staffFields(doc) {
  return {
    description: doc.description || '',
    address2: doc.address2 || '',
    company: doc.company || '',
    companyLegal: doc.companyLegal || '',
    parentCompany: doc.parentCompany ? String(doc.parentCompany) : null,
    addedBy: doc.addedBy || '',
    updatedBy: doc.updatedBy || '',
    dateAdded: doc.dateAdded || null,
    dateUpdated: doc.dateUpdated || null
  };
}

/** The published business card, plus the staff side of the model at level 2. */
function mirrorItem(eagleId, doc, read, existing) {
  return {
    id: eagleId,
    eagleId,
    kind: lists.KINDS.ORGANIZATION,
    sourceSystem: 'eagle',

    name: doc.name || '',
    companyType: doc.companyType || '',
    province: doc.province || '',
    country: doc.country || '',
    address1: doc.address1 || '',
    city: doc.city || '',
    postal: doc.postal || '',
    website: doc.website || '',
    ...staffFields(doc),

    isPublished: read.includes('public'),
    read,
    sources: { ...(existing && existing.sources), eagle: doc },
    ...Object.fromEntries(DEMI_OWNED_FIELDS
      .filter(f => existing && existing[f] !== undefined).map(f => [f, existing[f]]))
  };
}

/**
 * Row for this push: by Eagle id, else a DEMI row sync-out sent under that id. The id wins, as in
 * the comment-period mirror: a row stored under the Eagle id is that record's mirror.
 */
async function readTarget(eagleId) {
  return await lists.readForWrite(eagleId, lists.KINDS.ORGANIZATION)
    || await lists.readForWriteByEagleId(eagleId, lists.KINDS.ORGANIZATION);
}

/**
 * Mirror one raw Eagle `Organization`; also used by the backfill in src/scripts/seed-public-reads.js.
 * Throws `DUPLICATE_ID` only when two rows other than the one stored under the id name it.
 * @returns {Promise<{saved, existing}|{ignored, existing}|{status: 'conflict'}>}
 */
async function mirrorFromEagle(eagleId, doc, { pushedAt = null } = {}) {
  const read = eagleBaseAcl(doc.read);

  return upsertKeepingDemiRows(lists, eagleId, doc, (current) => mirrorItem(eagleId, doc, read, current),
    () => readTarget(eagleId), { pushedAt, label: 'Organization Controller' });
}

exports.mirrorFromEagle = mirrorFromEagle;
exports.staffFields = staffFields;

exports.upsertFromEagle = async (req, res) => {
  try {
    const push = eaglePush(req);
    if (!push) {
      return res.status(400).json({ error: 'body.doc._id must match the :eagleId in the path' });
    }
    const { eagleId, doc, pushedAt } = push;

    const written = await mirrorFromEagle(eagleId, doc, { pushedAt });
    if (written.status === 'conflict') {
      return pushConflict(res, { label: 'Organization Controller', eagleId });
    }
    const { saved, existing, ignored } = written;
    if (ignored) {
      return ignoreStalePush(req, res, {
        label: 'Organization Controller', action: 'organization.push',
        targetType: 'organization', current: existing, pushedAt
      });
    }

    auditEvent(req, {
      action: 'organization.push',
      targetType: 'organization',
      targetId: saved.id,
      detail: {
        eagleId,
        isPublishedFrom: existing ? existing.isPublished : null,
        isPublishedTo: saved.isPublished
      }
    });

    return res.json({ id: saved.id, action: 'upsert' });
  } catch (err) {
    return mirrorError(res, err, 'organization controller failed');
  }
};
