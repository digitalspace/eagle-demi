#!/usr/bin/env node
// Build-time asset for the map's invasive species dropdown. The layer holds 134k observations and
// WFS answers at most 10,000 rows per request, so the distinct list is paged here, not at runtime.
//
// Refresh with `yarn species:refresh` in frontend/.

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PAGE_SIZE = 10000;
export const WFS_URL = 'https://openmaps.gov.bc.ca/geo/pub/ows';
export const TYPE_NAME = 'pub:WHSE_FOREST_VEGETATION.IBC_INVASIVE_SPECIES_OBS_SP';
export const SOURCE_URL = 'https://catalogue.data.gov.bc.ca/dataset/invasive-species-of-british-columbia-observations';
const COLUMN = 'INVASIVE_PLANT';
const OUTPUT = resolve(dirname(fileURLToPath(import.meta.url)), '../public/data/invasive-species.json');

export function pageUrl(startIndex) {
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeName: TYPE_NAME,
    propertyName: COLUMN,
    outputFormat: 'csv',
    count: String(PAGE_SIZE),
    startIndex: String(startIndex),
    sortBy: COLUMN
  });
  return `${WFS_URL}?${params.toString()}`;
}

/** One CSV row. Quoted fields may hold commas, and a doubled quote is one quote. */
export function parseCsvRow(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char !== '"') field += char;
      else if (line[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

/** The named column of a CSV page. GeoServer ignores propertyName for CSV and sends every column. */
export function columnFromCsv(csv, column = COLUMN) {
  const lines = csv.split(/\r?\n/).filter(line => line.length > 0);
  if (lines.length === 0) return { values: [], rows: 0 };
  const index = parseCsvRow(lines[0]).indexOf(column);
  if (index === -1) throw new Error(`CSV page has no ${column} column: ${lines[0]}`);
  const rows = lines.slice(1);
  return { values: rows.map(line => parseCsvRow(line)[index] ?? ''), rows: rows.length };
}

/**
 * Distinct plants, ordered the way a person reads a list.
 *
 * One observation can name several plants in one field, joined as
 * `Baby's breath (Gypsophila paniculata), Bull thistle (Cirsium vulgare)`. Every name carries its
 * scientific name in brackets and none holds a comma, so the closing bracket is the split point.
 * Splitting turns 1,027 combinations into the 195 plants people actually search for, and an
 * `ILIKE '%one plant%'` still matches the combined rows.
 */
export function tidySpecies(values) {
  const distinct = new Set();
  for (const value of values) {
    const parts = value.split(/\),\s*/);
    parts.forEach((part, index) => {
      const name = (index < parts.length - 1 ? `${part})` : part).trim();
      if (name) distinct.add(name);
    });
  }
  return [...distinct].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}

export async function fetchSpecies(fetchImpl = fetch, log = () => {}) {
  const values = [];
  let rows = 0;
  for (let startIndex = 0; ; startIndex += PAGE_SIZE) {
    const res = await fetchImpl(pageUrl(startIndex));
    if (!res.ok) throw new Error(`WFS answered ${res.status} for startIndex ${startIndex}`);
    const page = columnFromCsv(await res.text());
    values.push(...page.values);
    rows += page.rows;
    log(`  rows ${rows}`);
    if (page.rows < PAGE_SIZE) break;
  }
  return { species: tidySpecies(values), rows };
}

async function main() {
  const { species, rows } = await fetchSpecies(fetch, message => process.stdout.write(`${message}\n`));
  const body = JSON.stringify({
    generated: new Date().toISOString().slice(0, 10),
    source: SOURCE_URL,
    species
  }, null, 2);
  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${body}\n`);
  process.stdout.write(`${species.length} species from ${rows} observations -> ${OUTPUT}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
