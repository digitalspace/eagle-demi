'use strict';

const BaseRepository = require('./base');

class LogRepository extends BaseRepository {
  constructor() {
    super('logs');
  }
}

const instance = new LogRepository();

module.exports = {
  find: (whereClause, parameters, options) => instance.find(whereClause, parameters, options),
  findById: (id) => instance.findById(id),
  findOne: (whereClause, parameters) => instance.findOne(whereClause, parameters),
  upsert: (doc) => instance.upsert(doc),
  deleteById: (id) => instance.deleteById(id),
  countDocuments: (whereClause, parameters) => instance.countDocuments(whereClause, parameters),
  instance
};
