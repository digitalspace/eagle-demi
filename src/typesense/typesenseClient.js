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

/**
 * Remove a document from the search index.
 *
 * Called directly by the hard-delete path rather than relying on the change feed, which does
 * not emit deletes in latest-version mode. Doing it explicitly is why the data model needs no
 * soft-delete marker at all.
 *
 * Best-effort by design: a failure here must not fail the delete. The record is already gone
 * from Cosmos, and the nightly full sync rebuilds the index from scratch with an alias swap,
 * so a stale entry self-corrects within a day. Throwing would leave the caller unable to tell
 * whether the delete happened.
 *
 * @returns {Promise<boolean>} true if removed, false if it was already absent or unreachable
 */
async function deleteFromIndex(collection, documentId) {
  try {
    await getClient().collections(collection).documents(String(documentId)).delete();
    return true;
  } catch (err) {
    // 404 is the normal case for a document that was never indexed.
    if (err && (err.httpStatus === 404 || err.name === 'ObjectNotFound')) return false;
    console.warn(
      `[Typesense] Could not remove ${collection}/${documentId} from the index ` +
      `(${err.message}); the nightly full sync will reconcile it.`
    );
    return false;
  }
}

/**
 * Remove every indexed chunk of a document in one call.
 *
 * By filter rather than by id: a document has an unbounded number of chunks and their ids are only
 * derivable from data that has just been deleted from Cosmos. Best-effort like deleteFromIndex —
 * the nightly full sync reconciles via alias swap, so this must not fail a successful delete.
 *
 * @returns {number} chunks removed, or 0 if the call failed or nothing was indexed.
 */
async function deleteChunksForDocument(documentId) {
  try {
    const result = await getClient()
      .collections('document_chunks')
      .documents()
      .delete({ filter_by: `documentId:=${String(documentId)}` });
    return (result && result.num_deleted) || 0;
  } catch (err) {
    if (err && (err.httpStatus === 404 || err.name === 'ObjectNotFound')) return 0;
    console.warn(
      `[Typesense] Could not remove chunks for document ${documentId} ` +
      `(${err.message}); the nightly full sync will reconcile them.`
    );
    return 0;
  }
}

module.exports = { getClient, deleteFromIndex, deleteChunksForDocument };
