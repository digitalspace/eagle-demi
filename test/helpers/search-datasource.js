'use strict';

/**
 * What a data source query hands the indexer, by index field name. The indexer maps by name, so a
 * field the query does not project is null on every row under green PUTs and runs.
 *
 * @param {string} query a Cosmos SQL data source query
 * @returns {Map<string,string>} projected name (the alias, where there is one) to source expression
 */
function projectedColumns(query) {
  // Top level only: a column may hold a subquery with its own SELECT, FROM and commas.
  const body = query.slice(query.indexOf('SELECT') + 'SELECT'.length);
  const cols = [];
  let depth = 0;
  let start = 0;
  let end = body.length;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '(') depth++;
    else if (body[i] === ')') depth--;
    else if (depth === 0 && body[i] === ',') {
      cols.push(body.slice(start, i));
      start = i + 1;
    } else if (depth === 0 && body.startsWith(' FROM ', i)) {
      end = i;
      break;
    }
  }
  cols.push(body.slice(start, end));
  return new Map(cols.map((col) => {
    const alias = /^\s*(.+?)\s+AS\s+(\w+)\s*$/i.exec(col);
    if (alias) return [alias[2], alias[1].replace(/^c\./, '')];
    const name = col.trim().replace(/^c\./, '');
    return [name, name];
  }));
}

module.exports = { projectedColumns };
