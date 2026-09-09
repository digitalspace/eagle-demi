'use strict';

const test = require('node:test');
const assert = require('node:assert');

const load = () => import('../../frontend/scripts/fetch-invasive-species.mjs');

const page = rows => ['FID,ISOS_SYSID,INVASIVE_PLANT,OBJECTID', ...rows].join('\n');

test('fetch-invasive-species', async (t) => {
  const script = await load();

  await t.test('reads a quoted field that holds commas', () => {
    assert.deepStrictEqual(
      script.parseCsvRow('a,"one, two",c'),
      ['a', 'one, two', 'c']
    );
    assert.deepStrictEqual(script.parseCsvRow('a,"say ""hi""",c'), ['a', 'say "hi"', 'c']);
  });

  await t.test('takes the column by name, because CSV pages carry every column', () => {
    const csv = page(['x,1,Bull thistle (Cirsium vulgare),9', 'y,2,Common tansy (Tanacetum vulgare),8']);
    assert.deepStrictEqual(script.columnFromCsv(csv), {
      values: ['Bull thistle (Cirsium vulgare)', 'Common tansy (Tanacetum vulgare)'],
      rows: 2
    });
  });

  await t.test('refuses a page whose column is missing rather than filling a list with junk', () => {
    assert.throws(() => script.columnFromCsv('FID,OBJECTID\n1,2'), /no INVASIVE_PLANT column/);
  });

  await t.test('splits an observation that names several plants, dedupes and sorts', () => {
    const values = [
      "Baby's breath (Gypsophila paniculata), Bull thistle (Cirsium vulgare)",
      'Bull thistle (Cirsium vulgare)',
      '  ',
      'American elm (Ulmus americana)'
    ];
    assert.deepStrictEqual(script.tidySpecies(values), [
      'American elm (Ulmus americana)',
      "Baby's breath (Gypsophila paniculata)",
      'Bull thistle (Cirsium vulgare)'
    ]);
  });

  await t.test('asks for one page per 10,000 rows, sorted so paging is stable', () => {
    const url = new URL(script.pageUrl(20000));
    assert.strictEqual(url.searchParams.get('count'), String(script.PAGE_SIZE));
    assert.strictEqual(url.searchParams.get('startIndex'), '20000');
    assert.strictEqual(url.searchParams.get('sortBy'), 'INVASIVE_PLANT');
    assert.strictEqual(url.searchParams.get('typeName'), script.TYPE_NAME);
  });

  await t.test('stops on the first short page', async () => {
    const asked = [];
    const fetchImpl = async (url) => {
      asked.push(url);
      return { ok: true, text: async () => page(['x,1,Bull thistle (Cirsium vulgare),9']) };
    };
    const result = await script.fetchSpecies(fetchImpl);
    assert.strictEqual(asked.length, 1);
    assert.strictEqual(result.rows, 1);
    assert.deepStrictEqual(result.species, ['Bull thistle (Cirsium vulgare)']);
  });

  await t.test('fails loudly on a bad answer instead of writing a short list', async () => {
    const fetchImpl = async () => ({ ok: false, status: 502, text: async () => '' });
    await assert.rejects(() => script.fetchSpecies(fetchImpl), /502/);
  });
});
