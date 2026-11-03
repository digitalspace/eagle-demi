'use strict';

const lists = require('../../src/repositories/lists');
const { canRead } = require('../../src/helpers/access-sql');

const PUBLISHED_ORG = '5c1f7a3e9b1d2c0012340001';
const HIDDEN_ORG = '5c1f7a3e9b1d2c0012340002';
const UNKNOWN_ORG = '5c1f7a3e9b1d2c0012340003';
// An Eagle-mirrored unpublished organization: privileged roles read it, staff does not.
const SEALED_ORG = '5c1f7a3e9b1d2c0012340004';

const ORGS = [
  { id: PUBLISHED_ORG, name: 'Acme', province: 'BC', read: ['public', 'staff', 'sysadmin'] },
  { id: HIDDEN_ORG, name: 'Hidden Co', province: 'AB', read: ['staff', 'sysadmin'] },
  { id: SEALED_ORG, name: 'Eagle Only', province: 'BC', read: ['sysadmin'] }
];

/** `lists.listOrganizationLabels` over ORGS, each row gated on its own `read[]` as the query gates it. */
function fakeOrgLabels(t) {
  const calls = [];
  t.mock.method(lists, 'listOrganizationLabels', async (access, ids) => {
    calls.push({ access, ids });
    return ORGS.filter(org => ids.includes(org.id) && canRead(org, access, null))
      .map(({ id, name, province }) => ({ id, name, province }));
  });
  return calls;
}

module.exports = { PUBLISHED_ORG, HIDDEN_ORG, UNKNOWN_ORG, SEALED_ORG, fakeOrgLabels };
