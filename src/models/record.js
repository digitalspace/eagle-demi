'use strict';

const BaseRepository = require('./base');

class RecordRepository extends BaseRepository {
  constructor() {
    super('records');
  }
}

const instance = new RecordRepository();

module.exports = {
  find: (filter, options) => instance.find(filter, options),
  findById: (id) => instance.findById(id),
  findOne: (filter, options) => instance.findOne(filter, options),
  upsert: (doc) => instance.upsert(doc),
  deleteById: (id) => instance.deleteById(id),
  countDocuments: (filter) => instance.countDocuments(filter),
  instance
};
