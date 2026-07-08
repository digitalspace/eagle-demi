'use strict';

const Typesense = require('typesense');

let _client = null;

function getClient() {
  if (!_client) {
    const hosts = (process.env.TYPESENSE_HOST || 'localhost').split(',');
    const nodes = hosts.map(h => ({
      host:     h.trim(),
      port:     parseInt(process.env.TYPESENSE_PORT || '8108', 10),
      protocol: process.env.TYPESENSE_PROTOCOL || 'http',
    }));
    _client = new Typesense.Client({
      nodes,
      apiKey:                   process.env.TYPESENSE_API_KEY || 'local-dev-key',
      connectionTimeoutSeconds: 30,
      retryIntervalSeconds:     5,
      numRetries:               3,
    });
  }
  return _client;
}

module.exports = { getClient };
