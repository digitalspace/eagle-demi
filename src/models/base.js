'use strict';

const { getItem, upsertItem, deleteItem, queryContainer, countContainer } = require('../db/cosmos');

class BaseRepository {
  constructor(containerName) {
    this.containerName = containerName;
  }

  async find(whereClause = '', parameters = [], options = {}) {
    const queryText = `SELECT * FROM c ${whereClause ? 'WHERE ' + whereClause : ''} ${options.orderBy ? 'ORDER BY ' + options.orderBy : ''}`;
    return queryContainer(this.containerName, { query: queryText, parameters }, options);
  }

  async findById(id) {
    if (!id) return null;
    return getItem(this.containerName, String(id));
  }

  async findOne(whereClause, parameters = []) {
    const results = await this.find(whereClause, parameters, { maxItemCount: 1 });
    return results && results.length > 0 ? results[0] : null;
  }

  async upsert(doc) {
    if (!doc) return null;
    const now = new Date().toISOString();
    if (!doc.createdAt) doc.createdAt = now;
    doc.updatedAt = now;
    if (!doc._id && !doc.id) {
      doc._id = String(doc.trackProjectId || doc.nrptiId || Date.now());
    }
    doc.id = String(doc._id || doc.id);
    return upsertItem(this.containerName, doc);
  }

  async deleteById(id) {
    return deleteItem(this.containerName, String(id));
  }

  async countDocuments(whereClause = '', parameters = []) {
    return countContainer(this.containerName, whereClause, parameters);
  }
}

module.exports = BaseRepository;
