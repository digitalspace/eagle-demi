'use strict';

/**
 * Public query names over row fields for a native list: `?project=` filters `projectId`. The
 * contract (`helpers/native-query.js`) keys filters by field, so the request is renamed before it.
 */

/**
 * Rename `query` keys by `names` ({ public: field }). The field spelling itself is refused, so each
 * filter has one name on the wire. Answers `{ error }` or `{ query }`.
 */
function renameParams(query, names) {
  const fields = Object.values(names);
  const out = {};
  for (const [key, value] of Object.entries(query || {})) {
    if (fields.includes(key)) return { error: `unknown parameter: ${key}` };
    out[Object.hasOwn(names, key) ? names[key] : key] = value;
  }
  return { query: out };
}

/** `handler` behind the rename: a refused name is a 400 before any read. */
function withParamNames(names, handler) {
  return (req, res) => {
    const renamed = renameParams(req.query, names);
    if (renamed.error) return res.status(400).json({ error: renamed.error });
    req.query = renamed.query;
    return handler(req, res);
  };
}

module.exports = { withParamNames };
