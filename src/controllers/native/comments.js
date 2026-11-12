'use strict';

/**
 * `GET /comments` and `/comments/:id`. `q` searches comment text only, never the author, and its
 * terms stay out of analytics events (`UNLOGGED_SEARCH_KINDS` in mirror-reads).
 */

const comments = require('../../repositories/comments');
const { listHandler, getHandler } = require('../nosql/mirror-reads');
const { projectParentJoin } = require('../../helpers/native-query');

const SPEC = Object.freeze({
  entity: 'comments',
  repository: comments.nativeRepository,
  sortKeys: ['dateAdded'],
  filters: ['periodId', 'projectId', 'eaoStatus'],
  aliases: { period: 'periodId', project: 'projectId' },
  multiValueFilters: ['eaoStatus'],
  qFields: ['comment'],
  parentJoin: projectParentJoin,
  audited: true,
  notFound: 'Comment not found'
});

exports.SPEC = SPEC;
exports.getComments = listHandler(SPEC);
exports.getComment = getHandler(SPEC);
