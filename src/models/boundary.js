'use strict';

const BaseRepository = require('./base');

class BoundaryRepository extends BaseRepository {
  constructor() {
    super('boundaries');
  }
}

const instance = new BoundaryRepository();

module.exports = {
  find: (filter, options) => instance.find(filter, options),
  findById: (id) => instance.findById(id),
  findOne: (filter, options) => instance.findOne(filter, options),
  upsert: (doc) => instance.upsert(doc),
  deleteById: (id) => instance.deleteById(id),
  countDocuments: (filter) => instance.countDocuments(filter),
  instance
};
