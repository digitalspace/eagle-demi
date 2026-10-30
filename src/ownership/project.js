'use strict';

// Who owns each project field: Track, Eagle, DEMI or the eagle-api push. A field has one owner
// (test/ownership/ownership.test.js); the merge rules that apply these lists are in src/merge/project.js.

const { SYNC_STATE_FIELDS } = require('./sync-out');

/**
 * `[targetField, trackField, eagleField]`; eagleField null means Eagle has no equivalent.
 * Track wins only when it supplies a value, so an empty Track field never blanks an Eagle one.
 */
const TRACK_PRECEDENCE = [
  ['name', 'name', 'name'],
  ['description', 'description', 'description'],
  ['projectType', 'type_name', 'type'],
  ['projectSubType', 'sub_type_name', null],
  // The Eagle slot keeps an Eagle-only project, which has no Track row, from a blank proponent.
  ['proponentName', 'proponent_name', 'proponentName'],
  ['projectState', 'project_state_name', 'status'],
  ['abbreviation', 'abbreviation', 'shortName'],
  ['address', 'address', 'location'],
  ['isActive', 'is_active', 'activeStatus'],
  // Stored verbatim: the column holds certificate state as well as certificate numbers.
  ['eaCertificate', 'ea_certificate', null],
  // `eacExpires` is also the substantial-start deadline.
  ['eacSigned', 'eac_signed', null],
  ['eacExpires', 'eac_expires', null]
];

/**
 * Eagle-only fields eagle-api's project GET returns (its `tagList`), catalog level 2 except the
 * public `substantially` pair. `dispute` and `disputeDate` come from eagle-admin's search instead.
 */
const EAGLE_STAFF_FIELDS = [
  'CELead', 'CELeadEmail', 'CELeadPhone', 'projectLeadId', 'responsibleEPDId', 'projLead',
  'addedBy', 'intake', 'dateCommentsOpen', 'dateCommentsClosed', 'duration', 'isTermsAgreed',
  'primaryContact', 'proMember', 'eaStatusDate', 'projectStatusDate', 'activeDate',
  'substantially', 'substantiallyDate', 'hasMetCommentPeriods', 'dispute', 'disputeDate'
];

/**
 * Fields only Eagle has. `applicableRegulation`, `pins`, `featuredDocuments` and `proponentId` are
 * Mongo ObjectIds, so they must reach DEMI resolved (`normalizeEagleSlot` in src/merge/project.js).
 */
const EAGLE_ONLY_FIELDS = [
  'eaStatus', 'eacDecision', 'decisionDate', 'currentPhaseName', 'phaseHistory',
  'legislation', 'legislationYear', 'review180Start', 'review45Start',
  'reviewExtensions', 'reviewSuspensions', 'substitution', 'CEAAInvolvement',
  'CEAALink', 'applicableRegulation', 'build', 'dateAdded', 'dateUpdated',
  'projectLead', 'projectLeadEmail', 'projectLeadPhone',
  'responsibleEPD', 'responsibleEPDEmail', 'responsibleEPDPhone',
  'complianceLead', 'execProjectDirector', 'eaoMember',
  'sector', 'commodity', 'region', 'fedElecDist', 'provElecDist',
  'projectCAC', 'projectCACPublished', 'cacEmail',
  'proponentId', 'pins', 'pinsRead', 'featuredDocuments',
  'overallProgress', 'code', 'nameSearchTerms',
  ...EAGLE_STAFF_FIELDS
];

/** Which `legislation_<year>` block is current, and the years held. */
const LEGISLATION_INDEX_FIELDS = ['currentLegislationYear', 'legislationYearList'];

// Open pattern, not a list: a new Act needs no change here.
const LEGISLATION_KEY = /^legislation_\d{4}$/;

/**
 * Fields that live only at the top level of a Mongo project; the rest is legislation-block content.
 * A shape list, not an owner list: `read` here is the Mongo ACL the merge resolves.
 */
const EAGLE_TOP_LEVEL_FIELDS = [
  '_id', 'read', 'write', 'delete', 'pins', 'pinsRead', 'pinsHistory', 'links',
  'featuredDocuments', 'projectCAC', 'cacMembers', 'cacEmail', 'projectCACPublished',
  '_schemaName', ...LEGISLATION_INDEX_FIELDS,
  '_updatedBy', '_addedBy', '_deletedBy', '__v'
];

/**
 * The stamp later pushes are ordered against, and the cascade still owed. Blanking them lets an
 * applied push land again or loses the cascade.
 */
const PUSH_BOOKKEEPING_FIELDS = ['eaglePushedAt', 'cascadePendingAt'];

/**
 * A carry rule, not an owner: a re-merge takes these back off the stored row because the seed feed
 * never sends them. Feed fields are not carried, or an EAO clear could never apply.
 */
const PUSH_ONLY_FIELDS = [
  'proponentId', 'proponentName', 'applicableRegulation', 'featuredDocuments',
  ...PUSH_BOOKKEEPING_FIELDS
];

/** Only DEMI writes these (PUT, `/level`, the dating pass, sync-out), so no re-merge can rebuild them. */
const DEMI_ONLY_FIELDS = ['tags', 'levelHeldAt', 'documentPhases', ...SYNC_STATE_FIELDS];

/** Each field's one owner. `legislation_<year>` blocks are Eagle's too (`LEGISLATION_KEY`). */
const OWNERS = Object.freeze({
  track: TRACK_PRECEDENCE.map(([target]) => target),
  eagle: [...EAGLE_ONLY_FIELDS, ...LEGISLATION_INDEX_FIELDS],
  push: PUSH_BOOKKEEPING_FIELDS,
  demi: DEMI_ONLY_FIELDS
});

/** Body keys `PUT /projects/:id` drops, plus `legislation_<year>` keys. */
const PUT_IGNORED_FIELDS = [
  // The partition key: changing it in Cosmos is a delete-and-reinsert, not an update.
  'id', 'trackProjectId',
  // PUT does not move a level; widening is `PUT /projects/:id/level`.
  'read', 'isPublished',
  // The cacPublished predicate reads this, so PUT must not set it (doc §2 item 7).
  'projectCACPublished',
  // Derived from `pinsRead` on every read, so a GET-then-PUT must not store a copy.
  'pinsPublished',
  // Eagle pushes the pinned-proponent list; a PUT copy would reach anonymous reads.
  'pins',
  // The current year moves only through `/level`.
  ...LEGISLATION_INDEX_FIELDS,
  // Catalogued at vis 2, so staff can send them back and break push ordering or the cascade.
  ...PUSH_BOOKKEEPING_FIELDS,
  // The code has a link record behind it, so only `PUT /projects/:id/short-code` moves it.
  'shortCode', 'shortCodeSource', 'legacyShortCodes', 'shortLinkUrl',
  // A GET-then-PUT sends Cosmos keys back; catalogued at maxVis 0 (or 2), they would 400 the edit.
  '_rid', '_self', '_attachments', '_ts', '_etag', 'sources'
];

module.exports = {
  TRACK_PRECEDENCE,
  EAGLE_STAFF_FIELDS,
  EAGLE_ONLY_FIELDS,
  LEGISLATION_INDEX_FIELDS,
  LEGISLATION_KEY,
  EAGLE_TOP_LEVEL_FIELDS,
  PUSH_BOOKKEEPING_FIELDS,
  PUSH_ONLY_FIELDS,
  DEMI_ONLY_FIELDS,
  OWNERS,
  PUT_IGNORED_FIELDS
};
