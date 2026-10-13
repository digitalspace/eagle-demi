'use strict';

/**
 * Native comment reads: `GET /comments` and `GET /comments/:id`, on the list contract in
 * `helpers/native-query.js`. `q` searches the comment text only, never the author, and its terms
 * stay out of the analytics events (`UNLOGGED_SEARCH_KINDS` in mirror-reads).
 */

const comments = require('../../repositories/comments');
const { listHandler, getHandler } = require('../nosql/mirror-reads');
const { projectParentJoin } = require('../../helpers/native-query');
const { withParamNames } = require('./params');

const SPEC = Object.freeze({
  entity: 'comments',
  repository: comments.nativeRepository,
  sortKeys: ['dateAdded'],
  filters: ['periodId', 'projectId', 'eaoStatus'],
  multiValueFilters: ['eaoStatus'],
  qFields: ['comment'],
  parentJoin: projectParentJoin,
  audited: true,
  notFound: 'Comment not found'
});

const PARAM_NAMES = Object.freeze({ period: 'periodId', project: 'projectId' });

exports.SPEC = SPEC;
exports.getComments = withParamNames(PARAM_NAMES, listHandler(SPEC));
exports.getComment = getHandler(SPEC);
