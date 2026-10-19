'use strict';

/** `legislation_<year>` blocks on a project read: each field as visible as its top-level counterpart. */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const projects = require('../../src/repositories/projects');
const projectController = require('../../src/controllers/nosql/project');
const { mergeEagleOnlyProject, TRACK_PRECEDENCE } = require('../../src/merge/project');
const { catalogFor } = require('../../src/vis/catalog');
const { mockRes } = require('../helpers/eagle-mirror-fixtures');

const catalog = catalogFor('projects');
const EAGLE_ID = '5850d1b4652f7e0019b52c0e';

/** Public fields, staff-only fields (level 2), and one field with no top-level counterpart. */
const block = (year) => ({
  name: `Mine ${year}`, type: 'Mines', legislationYear: year,
  CELead: 'Staff Lead', complianceLead: 'Compliance', cacEmail: 'cac@example.com',
  eaStatusDate: '2020-01-01', internalNote: 'not catalogued'
});

const ROW = mergeEagleOnlyProject({
  _id: EAGLE_ID,
  read: ['public', 'staff', 'sysadmin'],
  currentLegislationYear: 'legislation_2018',
  legislationYearList: [2002, 2018],
  legislation_2002: block(2002),
  legislation_2018: block(2018)
});

const read = async (t, user) => {
  t.mock.method(projects, 'getById', async () => structuredClone(ROW));
  const res = mockRes();
  await projectController.getProject({ params: { id: ROW.id }, query: {}, user }, res);
  return res.body;
};

/** Every `block.field` in a response whose top-level counterpart is not public at its default. */
const nonPublicFields = (body) => Object.keys(body)
  .filter(key => /^legislation_\d{4}$/.test(key))
  .flatMap(key => Object.keys(body[key])
    .filter(field => catalog[`${key}.${field}`].defaultVis < 4)
    .map(field => `${key}.${field}`));

test('legislation blocks on a project read', async (t) => {
  t.afterEach(() => t.mock.restoreAll());

  await t.test('an anonymous read gets the public fields of every block', async () => {
    const body = await read(t, undefined);

    assert.deepStrictEqual([body.legislation_2002.name, body.legislation_2002.type], ['Mine 2002', 'Mines']);
    assert.strictEqual(body.currentLegislationYear, 'legislation_2018');
  });

  await t.test('an anonymous read gets no staff-only field inside any block', async () => {
    const body = await read(t, undefined);

    assert.deepStrictEqual(nonPublicFields(body), []);
    assert.strictEqual(body.legislation_2002.CELead, undefined);
  });

  await t.test('a block field with no top-level counterpart is withheld from staff too', async () => {
    const body = await read(t, { realm_access: { roles: ['staff'] } });

    assert.strictEqual(body.legislation_2002.internalNote, undefined);
  });

  await t.test('staff get the staff-only fields inside a block', async () => {
    const body = await read(t, { realm_access: { roles: ['staff'] } });

    assert.strictEqual(body.legislation_2002.CELead, 'Staff Lead');
  });

  await t.test('a block field Eagle names differently is catalogued like the field it fills', () => {
    const differ = TRACK_PRECEDENCE.filter(([target, , eagle]) => eagle && eagle !== target)
      .filter(([target, , eagle]) => catalog[`legislation_2002.${eagle}`] !== catalog[target]);

    assert.deepStrictEqual(differ, []);
  });
});
