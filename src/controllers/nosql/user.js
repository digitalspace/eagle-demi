'use strict';

/**
 * User controller — the Eagle mirror for `User`, and the only writer of `users`.
 *
 * No parent: a user's own `read[]` through `seedAcl` is the whole ACL, so Eagle's default
 * `['sysadmin']` lands at level 2. Contact fields are 2/2 in catalog/users.js. Eagle's `password`
 * and `salt` are dropped before anything is built, the raw copy under `sources` included: eagle-api
 * already strips them, and a legacy row it missed must still not land here.
 */

const users = require('../../repositories/users');
const { seedAcl } = require('../../seed/transform');
const { mirrorError } = require('../../helpers/duplicate-id');
const { auditEvent } = require('../../utils/audit');
const {
  eaglePush, upsertWithRetry, ignoreStalePush, pushConflict, underDeleteCeiling, refId
} = require('./eagle-mirror');
const { listHandler, getHandler } = require('./mirror-reads');

const LABEL = 'User Controller';

function withoutSecrets(doc) {
  const { password: _password, salt: _salt, ...rest } = doc;
  return rest;
}

function mirrorItem(eagleId, doc, read, existing) {
  return {
    id: eagleId,
    eagleId,
    sourceSystem: 'eagle',

    firstName: doc.firstName || '',
    middleName: doc.middleName || null,
    lastName: doc.lastName || '',
    displayName: doc.displayName || '',
    salutation: doc.salutation || '',
    title: doc.title || '',
    department: doc.department || '',
    org: refId(doc.org),
    orgName: doc.orgName || '',

    email: doc.email || '',
    phoneNumber: doc.phoneNumber || '',
    cellPhoneNumber: doc.cellPhoneNumber || '',
    faxNumber: doc.faxNumber || '',
    address1: doc.address1 || '',
    address2: doc.address2 || '',
    city: doc.city || '',
    province: doc.province || '',
    country: doc.country || '',
    postalCode: doc.postalCode || '',
    notes: doc.notes || '',

    isDeleted: doc.isDeleted === true,
    isPublished: read.includes('public'),
    read,
    sources: { ...(existing && existing.sources), eagle: doc }
  };
}

/** @returns {Promise<{saved: object, existing: object|null}|{ignored: string, existing: object}|{status: 'conflict'}>} */
function mirrorFromEagle(eagleId, rawDoc, { pushedAt = null } = {}) {
  const doc = withoutSecrets(rawDoc);
  const read = underDeleteCeiling(seedAcl(doc.read), doc);
  return upsertWithRetry(
    users,
    (current) => mirrorItem(eagleId, doc, read, current),
    () => users.readForWrite(eagleId),
    { pushedAt }
  );
}

exports.mirrorFromEagle = mirrorFromEagle;

exports.upsertFromEagle = async (req, res) => {
  try {
    const push = eaglePush(req);
    if (!push) {
      return res.status(400).json({ error: 'body.doc._id must match the :eagleId in the path' });
    }
    const { eagleId, doc, pushedAt } = push;

    const written = await mirrorFromEagle(eagleId, doc, { pushedAt });
    if (written.status === 'conflict') return pushConflict(res, { label: LABEL, eagleId });
    const { saved, existing, ignored } = written;
    if (ignored) {
      return ignoreStalePush(req, res, {
        label: LABEL, action: 'user.push', targetType: 'user', current: existing, pushedAt
      });
    }

    auditEvent(req, {
      action: 'user.push',
      targetType: 'user',
      targetId: saved.id,
      detail: { eagleId, isDeleted: saved.isDeleted }
    });
    return res.json({ id: saved.id, action: 'upsert' });
  } catch (err) {
    return mirrorError(res, err, 'user controller failed');
  }
};

exports.getUsers = listHandler('users', (access, _query, page) => users.listVisible(access, page));
exports.getUser = getHandler('users', 'User not found', (access, id) => users.getById(access, id));
