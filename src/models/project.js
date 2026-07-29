'use strict';

const BaseRepository = require('./base');

class ProjectRepository extends BaseRepository {
  constructor() {
    super('projects');
  }
}

const instance = new ProjectRepository();

// Export singleton instance with static proxy methods for backward compatibility
module.exports = {
  find: (filter, options) => instance.find(filter, options),
  findById: (id) => instance.findById(id),
  findOne: (filter, options) => instance.findOne(filter, options),
  upsert: (doc) => instance.upsert(doc),
  deleteById: (id) => instance.deleteById(id),
  countDocuments: (filter) => instance.countDocuments(filter),
  instance
};
