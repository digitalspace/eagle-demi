'use strict';

const { getItem, upsertItem, deleteItem, queryContainer, countContainer } = require('../db/cosmos');

class BaseRepository {
  constructor(containerName) {
    this.containerName = containerName;
  }

  /**
   * @param {object} filter  MongoDB filter object (NOT a SQL string — see db/cosmos.js)
   * @param {object} options { maxItemCount|limit, sort }
   */
  async find(filter = {}, options = {}) {
    return queryContainer(this.containerName, filter, options);
  }

  async findById(id) {
    if (!id) return null;
    return getItem(this.containerName, String(id));
  }

  async findOne(filter = {}, options = {}) {
    const results = await this.find(filter, { ...options, maxItemCount: 1 });
    return results && results.length > 0 ? results[0] : null;
  }

  async upsert(doc) {
    if (!doc) return null;
    const now = new Date().toISOString();
    if (!doc.createdAt) doc.createdAt = now;
    doc.updatedAt = now;

    if (this.containerName === 'projects') {
      if (!doc.legacyEagleId && doc._id && isNaN(doc._id)) {
        doc.legacyEagleId = String(doc._id);
      }
      const masterId = String(doc.trackProjectId || doc._id || doc.id || Date.now());
      doc._id = masterId;
      doc.id = masterId;
      if (!doc.trackProjectId && !isNaN(masterId)) {
        doc.trackProjectId = Number(masterId);
      }
    } else {
      if (!doc._id && !doc.id) {
        doc._id = String(doc.nrptiId || Date.now());
      }
      doc.id = String(doc._id || doc.id);
    }
    return upsertItem(this.containerName, doc);
  }

  async deleteById(id) {
    return deleteItem(this.containerName, String(id));
  }

  async countDocuments(filter = {}) {
    return countContainer(this.containerName, filter);
  }
}

module.exports = BaseRepository;
