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
  const select = query.slice(query.indexOf('SELECT') + 'SELECT'.length, query.indexOf(' FROM '));
  return new Map(select.split(',').map((col) => {
    const alias = /^\s*(\S+)\s+AS\s+(\S+)\s*$/i.exec(col);
    if (alias) return [alias[2], alias[1].replace(/^c\./, '')];
    const name = col.trim().replace(/^c\./, '');
    return [name, name];
  }));
}

module.exports = { projectedColumns };
