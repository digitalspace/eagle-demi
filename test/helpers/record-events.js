'use strict';

// The audit and events rows a request leaves behind, read at the transport. Controllers hold their
// own references to `analyticsEvent`/`auditEvent`, so the writer is observed rather than mocked.

const config = require('../../src/config');
const audit = require('../../src/utils/audit');

const DCR_KEYS = ['auditDcrEndpoint', 'auditDcrImmutableId', 'eventsDcrEndpoint', 'eventsDcrImmutableId'];

/** Turns the writer on for test `t`; answers `rows(stream)`, which flushes and reads that stream. */
function recordEvents(t) {
  const saved = DCR_KEYS.map(key => config[key]);
  // Non-empty is what turns the writer on; the transport below means nothing is ever dialled.
  DCR_KEYS.forEach((key) => { config[key] = 'test-dcr'; });
  const sent = [];
  audit._setTransport(async (stream, rows) => { rows.forEach(row => sent.push({ stream, ...row })); });
  t.after(() => {
    DCR_KEYS.forEach((key, i) => { config[key] = saved[i]; });
    audit._resetTransport();
  });
  return async (stream) => {
    await audit.flush();
    return sent.filter(row => row.stream === stream);
  };
}

module.exports = { recordEvents };
