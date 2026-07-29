'use strict';

const BaseRepository = require('./base');

class WildfireRepository extends BaseRepository {
  constructor() {
    super('wildfires');
  }
}

const instance = new WildfireRepository();

module.exports = {
  find: (filter, options) => instance.find(filter, options),
  findById: (id) => instance.findById(id),
  findOne: (filter, options) => instance.findOne(filter, options),
  upsert: (doc) => instance.upsert(doc),
  deleteById: (id) => instance.deleteById(id),
  countDocuments: (filter) => instance.countDocuments(filter),
  instance
};
