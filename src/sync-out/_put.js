'use strict';

const { call, failure } = require('./eagle');

/** PUT `body` to an Eagle record; false when `isMissing` reads the answer as no such record. */
async function putRecord(s, path, body, logFields, isMissing = (res) => res.status === 404) {
  const res = await call(s, 'PUT', path, body, logFields);
  if (isMissing(res)) return false;
  if (!res.ok) throw failure('PUT', path, res);
  return true;
}

module.exports = { putRecord };
