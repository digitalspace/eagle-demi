'use strict';

/**
 * What a data source query actually hands the indexer, keyed by the name the index sees.
 *
 * The index definition and the data source query are two hand-PUT files that never see each other,
 * and the indexer maps them BY NAME: a field the index declares and the query does not project is
 * indexed as null on every row, under a 200 from every PUT and a green indexer run. That drift is
 * invisible to the container, to CI and to the app — which reads the index definition and so
 * believes the field is populated.
 *
 * Shared because two suites ask the same question of the same files: `azure/search-datasource-
 * columns.test.js` compares the query with the index, and `search/ai-search.test.js` compares it
 * with the selects the app sends. A second copy of the parser is a second thing to be wrong.
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
