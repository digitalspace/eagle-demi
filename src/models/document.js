'use strict';

const BaseRepository = require('./base');

class DocumentRepository extends BaseRepository {
  constructor() {
    super('documents');
  }
}

const instance = new DocumentRepository();

module.exports = {
  find: (filter, options) => instance.find(filter, options),
  findById: (id) => instance.findById(id),
  findOne: (filter, options) => instance.findOne(filter, options),
  upsert: (doc) => instance.upsert(doc),
  deleteById: (id) => instance.deleteById(id),
  countDocuments: (filter) => instance.countDocuments(filter),
  instance
};
