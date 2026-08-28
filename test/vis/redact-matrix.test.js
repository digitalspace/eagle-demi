'use strict';

process.env.NODE_ENV = 'test';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

const { visible, effectiveVis, redactForAccess, redactAllForAccess } = require('../../src/vis/redact');
const config = require('../../src/config');
const { code } = require('../helpers/router-source');

// The redactor allowlists `sources.*` by ENRICHMENT_SOURCES; test deploys name wildfire.
config.enrichmentSources = ['wildfire'];

const REDACT_PATH = path.join(__dirname, '..', '..', 'src', 'vis', 'redact.js');

/** A stored project row as Cosmos hands it back, written out by hand. */
function storedRow(overrides = {}) {
  return {
    id: '207',
    name: 'Coal Mountain',
    projectLead: 'Alex Lead',
    complianceLead: 'Casey Compliance',
    read: ['public', 'sysadmin', 'staff'],
    isPublished: true,
    sources: { track: { track_project_id: 207 }, wildfire: { fires: 2 } },
    _rid: 'abc==',
    _self: 'dbs/x/colls/y/docs/z',
    _attachments: 'attachments/',
    _ts: 1756300000,
    _etag: '"0000-1111"',
    ...overrides
  };
}

test('redactForAccess', async (t) => {
  await t.test('a level 4 caller sees the public fields and not the ACL', () => {
    const out = redactForAccess('projects', storedRow(), { level: 4 });
    assert.strictEqual(out.name, 'Coal Mountain');
    assert.strictEqual(out.projectLead, 'Alex Lead');
    assert.strictEqual('read' in out, false);
    assert.strictEqual('_rid' in out, false);
    assert.strictEqual('_self' in out, false);
    assert.strictEqual('_attachments' in out, false);
    assert.strictEqual('_ts' in out, false);
    assert.strictEqual('_etag' in out, false);
    assert.strictEqual('complianceLead' in out, false);
  });

  await t.test('level 0 runs the same loop', () => {
    // `0 <= effVis` holds for every field, so level 0 sees them all (doc §2 item 4) — the loop is
    // still what puts them there. An `if (level === 0) return record` shortcut fails on the
    // uncatalogued key and on the derived isPublished below.
    const row = storedRow({ notInTheCatalog: 'x', read: ['staff'], isPublished: true });
    const out = redactForAccess('projects', row, { level: 0 });
    assert.strictEqual('notInTheCatalog' in out, false);
    assert.strictEqual(out.isPublished, false);
    assert.deepStrictEqual(out.read, ['staff']);
    assert.strictEqual(out.complianceLead, 'Casey Compliance');
    assert.strictEqual(out._etag, '"0000-1111"');
  });

  await t.test('an unknown entity throws for every level', () => {
    assert.throws(() => redactForAccess('widgets', storedRow(), { level: 0 }), /no field catalog/);
    assert.throws(() => redactForAccess('widgets', storedRow(), { level: 4 }), /no field catalog/);
  });

  await t.test('a missing level is treated as anonymous', () => {
    const out = redactForAccess('projects', storedRow(), {});
    assert.strictEqual('complianceLead' in out, false);
    assert.strictEqual('_etag' in out, false);
    assert.strictEqual(out.name, 'Coal Mountain');
  });

  await t.test('an uncatalogued key is removed', () => {
    const out = redactForAccess('projects', storedRow({ notInTheCatalog: 'x' }), { level: 0 });
    assert.strictEqual('notInTheCatalog' in out, false);
  });

  await t.test('a dial restricts below defaultVis', () => {
    const row = storedRow({ vis: { projectLead: 1 } });
    assert.strictEqual('projectLead' in redactForAccess('projects', row, { level: 4 }), false);
    assert.strictEqual('projectLead' in redactForAccess('projects', row, { level: 2 }), false);
    assert.strictEqual(redactForAccess('projects', row, { level: 1 }).projectLead, 'Alex Lead');
    assert.strictEqual(redactForAccess('projects', row, { level: 0 }).projectLead, 'Alex Lead');
  });

  await t.test('a dial cannot exceed maxVis', () => {
    const row = storedRow({ vis: { read: 4 } });
    assert.strictEqual('read' in redactForAccess('projects', row, { level: 4 }), false);
    assert.strictEqual('read' in redactForAccess('projects', row, { level: 2 }), false);
  });

  await t.test('an invalid dial falls back to defaultVis', () => {
    for (const dial of ['yes', -3, 1.5, null, 9]) {
      const row = storedRow({ vis: { name: dial } });
      assert.strictEqual(redactForAccess('projects', row, { level: 4 }).name, 'Coal Mountain',
        `dial ${JSON.stringify(dial)} should fall back to defaultVis`);
    }
  });

  await t.test('the dial map is withheld from everyone below level 0', () => {
    // Handing it out at level 2 would name the fields restricted below 2 (doc §2 item 8).
    for (const level of [1, 2, 3, 4]) {
      const out = redactForAccess('projects', storedRow({ vis: { name: 1 } }), { level });
      assert.strictEqual('vis' in out, false, `level ${level} must not see the dial map`);
    }
  });

  await t.test('isPublished is derived, not copied', () => {
    const published = redactForAccess('projects', { read: ['public'], isPublished: false }, { level: 4 });
    assert.strictEqual(published.isPublished, true);

    const withheld = redactForAccess('projects', { read: ['staff'], isPublished: true }, { level: 4 });
    assert.strictEqual(withheld.isPublished, false);

    const noAcl = redactForAccess('projects', { isPublished: true }, { level: 4 });
    assert.strictEqual(noAcl.isPublished, true);
  });

  await t.test('the dotted enrichment key survives while its parent does not', () => {
    const out = redactForAccess('projects', storedRow(), { level: 4 });
    assert.deepStrictEqual(out.sources, { wildfire: { fires: 2 } });
  });

  await t.test('a parent with no visible child is dropped entirely', () => {
    const out = redactForAccess('projects', storedRow({ sources: { track: { a: 1 } } }), { level: 4 });
    assert.strictEqual('sources' in out, false);
  });

  await t.test('redactAllForAccess maps every row', () => {
    const out = redactAllForAccess('projects', [storedRow(), storedRow({ id: '208' })], { level: 4 });
    assert.strictEqual(out.length, 2);
    assert.deepStrictEqual(out.map(r => r.id), ['207', '208']);
    assert.strictEqual('read' in out[0], false);
    assert.strictEqual('read' in out[1], false);
  });
});

test('effectiveVis and visible', async (t) => {
  await t.test('visible is a plain level comparison', () => {
    assert.strictEqual(visible(4, 4), true);
    assert.strictEqual(visible(4, 2), false);
    assert.strictEqual(visible(0, 0), true);
    assert.strictEqual(visible(2, 4), true);
  });

  await t.test('effectiveVis clamps a valid dial to maxVis and rejects the rest', () => {
    const entry = { defaultVis: 4, maxVis: 4 };
    assert.strictEqual(effectiveVis(entry, undefined), 4);
    assert.strictEqual(effectiveVis(entry, 1), 1);
    assert.strictEqual(effectiveVis(entry, 'yes'), 4);
    assert.strictEqual(effectiveVis(entry, -3), 4);
    assert.strictEqual(effectiveVis({ defaultVis: 0, maxVis: 0 }, 4), 0);
    assert.strictEqual(effectiveVis({ defaultVis: 2, maxVis: 4 }, undefined), 2);
    assert.strictEqual(effectiveVis({ defaultVis: 2, maxVis: 4 }, 4), 4);
  });

  await t.test('a catalog entry carrying a predicate refuses to load', () => {
    // Ignoring `when` instead of throwing would read as "always visible" — a half-shipped
    // predicate must break the build, not widen a field (doc §2 item 7).
    const catalog = require('../../src/vis/catalog/projects');
    const modulePath = require.resolve('../../src/vis/redact');
    catalog.cacEmail.when = 'cacPublished';
    delete require.cache[modulePath];
    try {
      assert.throws(() => require('../../src/vis/redact'), /predicates are not supported/);
    } finally {
      delete catalog.cacEmail.when;
      delete require.cache[modulePath];
      require('../../src/vis/redact');
    }
  });

  await t.test('visible() is the only comparison', () => {
    // Inlining a second `level <= effVis` anywhere in the redactor fails this.
    const source = code(fs.readFileSync(REDACT_PATH, 'utf8'));
    assert.strictEqual(source.match(/<=|>=/g).length, 1);
  });
});
