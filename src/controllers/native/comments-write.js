'use strict';

/**
 * Comment writes through domain/comments.js. Apart from the reads in comments.js because those
 * answer `res` themselves, which a controller importing `domain/` may not.
 */

const comments = require('../../repositories/comments');
const comment = require('../../domain/comments');
const { writeHandler } = require('./write');

const WRITES = { entity: comments.CONTAINER };

module.exports = {
  createComment: writeHandler(comment.create, WRITES),
  updateComment: writeHandler(comment.update, WRITES),
  setCommentStatus: writeHandler(comment.setStatus, WRITES)
};
