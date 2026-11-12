'use strict';

/**
 * Eagle mirror for `User`; DEMI's own writes are in domain/users.js. `password` and `salt` are
 * dropped, raw copy included, and a DEMI-owned user takes only the raw copy on a push.
 */

const users = require('../../repositories/users');
const { eagleBaseAcl } = require('../../seed/transform');
const { upsertKeepingDemiRows, pushHandler, underDeleteCeiling, refId } = require('./eagle-mirror');
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

/** The `read` the mirror stores for an Eagle user doc. */
function storedRead(doc) {
  return underDeleteCeiling(eagleBaseAcl(doc.read), doc);
}

/** @returns {Promise<{saved: object, existing: object|null}|{ignored: string, existing: object}|{status: 'conflict'}>} */
function mirrorFromEagle(eagleId, rawDoc, { pushedAt = null } = {}) {
  const doc = withoutSecrets(rawDoc);
  const read = storedRead(doc);
  return upsertKeepingDemiRows(users, eagleId, doc, (current) => mirrorItem(eagleId, doc, read, current),
    () => users.readForWrite(eagleId), { pushedAt, label: LABEL });
}

exports.mirrorFromEagle = mirrorFromEagle;
exports.storedRead = storedRead;

exports.upsertFromEagle = pushHandler({
  label: LABEL, action: 'user.push', targetType: 'user', mirror: mirrorFromEagle,
  detail: (saved, _existing, eagleId) => ({ eagleId, isDeleted: saved.isDeleted }),
  failure: 'user controller failed'
});

// Staff reads of people are audited, as eagle-api records them; `q` (names, emails) never reaches analytics.
const USERS = {
  entity: 'users',
  repository: users.native,
  sortKeys: ['displayName', 'orgName', 'email', 'phoneNumber'],
  filters: [],
  qFields: ['displayName', 'email'],
  audited: true,
  notFound: 'User not found'
};

exports.nativeSpec = USERS;
exports.getUsers = listHandler(USERS);
exports.getUser = getHandler(USERS);
