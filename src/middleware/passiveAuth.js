'use strict';

const { authenticate } = require('../helpers/auth');

module.exports = (req, res, next) => {
  authenticate(
    req,
    (user) => {
      req.user = user;
      return next();
    },
    () => {
      return next();
    }
  );
};
