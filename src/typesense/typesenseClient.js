'use strict';

const Typesense = require('typesense');

let _client = null;

function getClient() {
  if (!_client) {
    let nodes = [];
    if (process.env.TYPESENSE_URL) {
      try {
        const u = new URL(process.env.TYPESENSE_URL);
        nodes = [{
          host:     u.hostname,
          port:     u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80),
          protocol: u.protocol.replace(':', ''),
        }];
      } catch (err) {
        console.warn('[Typesense] Failed to parse TYPESENSE_URL, falling back:', err);
      }
    }
    if (nodes.length === 0) {
      const hosts = (process.env.TYPESENSE_HOST || 'localhost').split(',');
      nodes = hosts.map(h => ({
        host:     h.trim(),
        port:     parseInt(process.env.TYPESENSE_PORT || '8108', 10),
        protocol: process.env.TYPESENSE_PROTOCOL || 'http',
      }));
    }
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
