'use strict';

const assert = require('node:assert');

const cosmos = require('../../src/db/cosmos-nosql');
const { visibilityFor, canRead } = require('../../src/helpers/access-sql');
const { evaluate } = require('./updates-store');

const PUBLIC = ['staff', 'idir', 'public'];

/** A public project row, with its own dials when given. */
const dialRow = (id, vis) => ({ id, name: id, read: PUBLIC, ...(vis ? { vis } : {}) });

/** Answer `cosmos.queryPage` over `rows`: the ACL by its JS twin `canRead`, the rest by the evaluator. */
function hiddenStore(t, rows, access) {
  const pages = [];
  t.mock.method(cosmos, 'queryPage', async (container, spec, options) => {
    pages.push({ container, spec, options });
    const where = /^SELECT VALUE c\.id FROM c WHERE (.+)$/s.exec(spec.query)[1];
    const acl = `(${visibilityFor(access, 'id').clause}) AND `;
    assert.ok(where.startsWith(acl), 'the read leads with the caller\'s ACL predicate');
    const params = Object.fromEntries(spec.parameters.map(p => [p.name, p.value]));
    return rows.filter(r => canRead(r, access, 'id') && evaluate(where.slice(acl.length), r, params))
      .map(r => r.id).slice(0, options.size);
  });
  return pages;
}

module.exports = { dialRow, hiddenStore };
