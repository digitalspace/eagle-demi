'use strict';

const cosmos = require('../db/cosmos-nosql');
const { eq, selectWhere } = require('./_sql');

/** By-id read across every partition, gated by the caller's access; `criteria` go before the id match. */
async function firstByIdAcross(container, access, partitionField, id, criteria = []) {
  const spec = selectWhere({ access, partitionField, criteria: [...criteria, eq('id', String(id), '@id')] });
  // Pages are drained, not sampled: one page of a cross-partition lookup can come back empty while
  // the row exists, and the caller reads that as "no such row".
  return await cosmos.queryFirst(container, spec, {});
}

module.exports = { firstByIdAcross };
