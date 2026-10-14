'use strict';

// The route inventory in docs/eagle-api-port.md (Audit): every non-GET route has an audit action
// or an exempt reason. One file per object under route-inventory/, each exporting
// `{ 'METHOD /path': entry }`. An entry holds `action` (string or list) or `exempt` (reason), and:
// `in`, the module under src/ holding the action when the handler delegates; `expr`, the source
// that builds an action the handler does not spell out; `roles`, a ported route's eagle-api
// x-security-scopes, copied as written, which must equal its `requireRole(...)` names.

process.env.NODE_ENV = 'test';
// Before src/config is first required: loading the handlers loads the audit writer.
process.env.AUDIT_DCR_ENDPOINT = 'https://dcr-test.canadacentral-1.ingest.monitor.azure.com';
process.env.AUDIT_DCR_IMMUTABLE_ID = 'dcr-testimmutableid';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const { code, routeChains } = require('../helpers/router-source');
const routes = require('../../src/http/routes');
const inspectionsRepo = require('../../src/repositories/inspections');

const SRC = path.join(__dirname, '..', '..', 'src');
const INVENTORY_DIR = path.join(__dirname, 'route-inventory');

const keyOf = route => `${route.method.toUpperCase()} ${route.path}`;
const roleSet = roles => [...new Set(roles)].sort();

/** Every inventory file merged, and each key that more than one file claims. */
function loadInventory(dir) {
  const inventory = {};
  const duplicates = [];
  for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.js')).sort()) {
    for (const [key, entry] of Object.entries(require(path.join(dir, file)))) {
      if (key in inventory) duplicates.push(`${key} (${file})`);
      inventory[key] = entry;
    }
  }
  return { inventory, duplicates };
}

/** Keys of `writeRoutes` with no entry in `inventory`. */
const missingEntries = (writeRoutes, inventory) => writeRoutes.map(keyOf).filter(key => !(key in inventory));

/** Entries whose `roles` differ from the `requireRole(...)` names on their route. */
function roleMismatches(writeRoutes, inventory) {
  return writeRoutes
    .filter(route => inventory[keyOf(route)] && inventory[keyOf(route)].roles)
    .filter(route => {
      const guarded = route.guards.filter(guard => guard.roles).map(guard => roleSet(guard.roles));
      return !isDeepStrictEqual(guarded, [roleSet(inventory[keyOf(route)].roles)]);
    })
    .map(keyOf);
}

/** Path under src/ of the one loaded module exporting this route's handler. */
function handlerModule(route) {
  const handler = route.load();
  const owners = Object.values(require.cache).filter(m =>
    m.filename.startsWith(SRC) && m.exports && Object.values(m.exports).includes(handler));
  assert.strictEqual(owners.length, 1, `handler exported by ${owners.length} modules`);
  return path.relative(SRC, owners[0].filename);
}

const { inventory: INVENTORY, duplicates } = loadInventory(INVENTORY_DIR);
const writeChains = routeChains().filter(route => route.method !== 'get');
const writeRoutes = routes.filter(route => route.method !== 'get');
const writeKeys = writeChains.map(keyOf);

test('no inventory file claims a route another file holds', () => {
  assert.deepStrictEqual(duplicates, []);
});

test('no route is declared twice', () => {
  assert.deepStrictEqual(writeKeys.filter((key, i) => writeKeys.indexOf(key) !== i), []);
});

test('every non-GET route has an inventory entry', () => {
  assert.deepStrictEqual(missingEntries(writeChains, INVENTORY), [], 'routes with no entry in test/controllers/route-inventory/');
});

test('no entry names a route that is gone', () => {
  assert.deepStrictEqual(Object.keys(INVENTORY).filter(key => !writeKeys.includes(key)), []);
});

test('every entry holds an action or a reason, not both', () => {
  const malformed = Object.keys(INVENTORY)
    .filter(key => ('action' in INVENTORY[key]) === ('exempt' in INVENTORY[key]) || INVENTORY[key].exempt === '');
  assert.deepStrictEqual(malformed, []);
});

test('every entry with roles matches its route\'s requireRole guard', () => {
  assert.deepStrictEqual(roleMismatches(writeRoutes, INVENTORY), []);
});

test('inspection actions are the repository entity names the handler builds them from', () => {
  const { ENTITY, KINDS } = inspectionsRepo;
  assert.strictEqual(INVENTORY['PUT /eagle/inspections/:eagleId'].action, `${ENTITY[KINDS.INSPECTION]}.push`);
  assert.strictEqual(INVENTORY['PUT /eagle/inspection-elements/:eagleId'].action, `${ENTITY[KINDS.ELEMENT]}.push`);
  assert.strictEqual(INVENTORY['PUT /eagle/inspection-items/:eagleId'].action, `${ENTITY[KINDS.ITEM]}.push`);
});

test('every audited route\'s handler source names its action', async (t) => {
  for (const route of writeRoutes.filter(r => INVENTORY[keyOf(r)] && INVENTORY[keyOf(r)].action)) {
    const entry = INVENTORY[keyOf(route)];
    await t.test(`${keyOf(route)} writes ${[].concat(entry.action).join(' | ')}`, () => {
      const file = entry.in || handlerModule(route);
      const source = code(fs.readFileSync(path.join(SRC, file), 'utf8'));
      const wanted = entry.expr ? [entry.expr] : [].concat(entry.action).map(action => `'${action}'`);
      assert.deepStrictEqual(wanted.filter(w => !source.includes(w)), [], `not in src/${file}`);
    });
  }
});

// The checks above pass on today's table; these prove each one can fail.
test('a route with no entry is named', () => {
  const route = { method: 'post', path: '/things', guards: [] };
  assert.deepStrictEqual(missingEntries([route], {}), ['POST /things']);
});

test('roles that differ from the guard, or a guard with no roles, are named', () => {
  const guard = Object.assign(() => {}, { roles: Object.freeze(['staff', 'sysadmin']) });
  const table = [
    { method: 'post', path: '/same', guards: [() => {}, guard] },
    { method: 'post', path: '/other', guards: [guard] },
    { method: 'put', path: '/unguarded', guards: [() => {}] },
    { method: 'delete', path: '/no-roles', guards: [guard] }
  ];
  const entries = {
    'POST /same': { action: 'a', roles: ['sysadmin', 'staff'] },
    'POST /other': { action: 'a', roles: ['project-system-admin'] },
    'PUT /unguarded': { action: 'a', roles: ['staff'] },
    'DELETE /no-roles': { action: 'a' }
  };
  assert.deepStrictEqual(roleMismatches(table, entries), ['POST /other', 'PUT /unguarded']);
});
