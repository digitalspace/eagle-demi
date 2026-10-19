'use strict';

/**
 * Comment period writes through domain/comment-periods.js. Apart from the reads because the
 * summary read answers `res` itself, which a controller importing `domain/` may not.
 */

const commentPeriods = require('../../repositories/comment-periods');
const commentPeriod = require('../../domain/comment-periods');
const { writeHandler } = require('./write');

const WRITES = { entity: commentPeriods.CONTAINER };

module.exports = {
  createCommentPeriod: writeHandler(commentPeriod.create, WRITES),
  updateCommentPeriod: writeHandler(commentPeriod.update, WRITES),
  deleteCommentPeriod: writeHandler(commentPeriod.remove, WRITES),
  publishCommentPeriod: writeHandler(commentPeriod.publish, WRITES),
  unpublishCommentPeriod: writeHandler(commentPeriod.unpublish, WRITES)
};
