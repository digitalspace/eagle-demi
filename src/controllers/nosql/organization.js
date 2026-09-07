'use strict';

/**
 * Organization controller — the Eagle mirror for `Organization`, written into `lists` as
 * `kind: 'Organization'`.
 *
 * No parent to constrain against: an organization is not project data, so its own `read[]` is the
 * whole ACL. The pinned-proponent list is governed separately, by each project's `pinsRead[]` —
 * see the `pinsPublished` predicate.
 */

const lists = require('../../repositories/lists');
const { seedAcl } = require('../../seed/transform');
const { systemAccess } = require('../../helpers/access-sql');
const { serverError } = require('../../helpers/response');
const { auditEvent } = require('../../utils/audit');
const { eaglePush, upsertWithRetry } = require('./eagle-mirror');

/** The published business card, and nothing from the staff side of the model. */
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

    isPublished: read.includes('public'),
    read,
    sources: { ...(existing && existing.sources), eagle: doc }
  };
}

/**
 * Mirror one raw Eagle `Organization`, whoever asked — the push handler below or the backfill
 * (src/scripts/seed-public-reads.js). No parent, so there is nothing it can fail to resolve.
 *
 * @returns {Promise<{saved: object, existing: object|null}>}
 */
function mirrorFromEagle(eagleId, doc) {
  const read = seedAcl(doc.read);

  return upsertWithRetry(
    lists,
    (current) => mirrorItem(eagleId, doc, read, current),
    () => lists.getById(systemAccess(), eagleId, lists.KINDS.ORGANIZATION)
  );
}

exports.mirrorFromEagle = mirrorFromEagle;

exports.upsertFromEagle = async (req, res) => {
  try {
    const push = eaglePush(req);
    if (!push) {
      return res.status(400).json({ error: 'body.doc._id must match the :eagleId in the path' });
    }
    const { eagleId, doc } = push;

    const { saved, existing } = await mirrorFromEagle(eagleId, doc);

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
    return serverError(res, err, 'organization controller failed');
  }
};
