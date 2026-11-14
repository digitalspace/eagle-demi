'use strict';

// Devbox, test only: `scripts/demi-devbox.sh run --env test -- node src/scripts/check-business-works-parity.js <options>`.
// Read-only; stdout holds counts only, and listed items go sealed to the operator, as sourceKeys hold sheet numbers.

const fs = require('fs');
const { parseArgs } = require('util');
const { systemAccess } = require('../helpers/access-sql');
const projectsRepository = require('../repositories/projects');
const worksRepository = require('../repositories/works');
const commentPeriodsRepository = require('../repositories/comment-periods');
const listsRepository = require('../repositories/lists');
const phaseCatalog = require('../domain/phase-catalog');
const { COUNTS, FAILING, parityOf, refuse } = require('../domain/business-works-parity');
const { OVERRIDE_MARKER_ID } = require('../domain/work-model');
const {
  devboxKeysFromPem, openExtract, operatorRecipientOf, readCapped, writeSealed
} = require('../utils/import-envelope');
const { COSMOS_HOST, readCrosswalk } = require('./works-crosswalk');
const { logger } = require('../utils/logger');

const ENV = 'test';
// `extract.js open --purpose works-parity` reads it back.
const REPORT_PURPOSE = 'works-parity';
const OPTIONS = ['extract', 'expect-extract-sha256', 'crosswalk', 'expect-manual-sha256', 'devbox-key', 'operator-key',
  'expect-operator-fingerprint', 'out-dir'];
const MAX_BYTES = { extract: 64 * 1024 * 1024, crosswalk: 4 * 1024 * 1024, key: 64 * 1024 };


/** Options, refused unless COSMOS_ENDPOINT is the test account, so this check never reads prod. */
function optionsOf(argv, endpoint = process.env.COSMOS_ENDPOINT) {
  const host = URL.canParse(endpoint || '') ? new URL(endpoint).hostname : '';
  const [, env] = COSMOS_HOST.exec(host) || [];
  if (env !== ENV) refuse('COSMOS_ENDPOINT must name demi-cosmos-test');
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: Object.fromEntries(OPTIONS.map(name => [name, { type: 'string' }])), strict: true, tokens: true });
  } catch {
    refuse(`options are --${OPTIONS.join(', --')}, each with one value`);
  }
  const given = parsed.tokens.filter(token => token.kind === 'option').map(token => token.name);
  const twice = OPTIONS.filter(name => given.filter(one => one === name).length > 1);
  if (twice.length) refuse(`--${twice.join(', --')} given more than once`);
  const missing = OPTIONS.filter(name => !parsed.values[name]);
  if (missing.length) refuse(`missing --${missing.join(', --')}`);
  if (!fs.statSync(parsed.values['out-dir'], { throwIfNoEntry: false })?.isDirectory()) refuse('--out-dir must be a directory');
  return parsed.values;
}

/** The keys, the decrypted extract and the crosswalk Map of register number to project id; nothing touches disk. */
function openInputs(o) {
  const keys = devboxKeysFromPem(readCapped(o['devbox-key'], MAX_BYTES.key).toString('utf8'));
  const recipient = operatorRecipientOf(o['operator-key'], o['expect-operator-fingerprint'], refuse);
  const { extract, sha256 } = openExtract(readCapped(o.extract, MAX_BYTES.extract), {
    env: ENV, keyFingerprint: keys.fingerprint, privateKey: keys.rsa, expectSha256: o['expect-extract-sha256']
  });
  const { rows } = readCrosswalk(readCapped(o.crosswalk, MAX_BYTES.crosswalk), {
    env: ENV, keys, expectExtractSha256: sha256, expectManualSha256: o['expect-manual-sha256']
  });
  return { keys, recipient, extract, extractSha256: sha256, crosswalk: new Map(rows.map(row => [Number(row.sheetId), row.targetId])) };
}

/** Signs the report with the devbox key and seals it to the operator under a random name; returns the name and hash. */
function writeReport(report, { keys, recipient, outDir }) {
  const { name, sha256 } = writeSealed(outDir, Buffer.from(JSON.stringify(report)), {
    purpose: REPORT_PURPOSE, env: ENV, recipient, signingKey: keys.ed25519
  });
  return { blob: name, sha256 };
}

/** The phase catalog, refused when a year lacks entries: W7 would then place no phase for that Act. */
async function phasesOf() {
  const loaded = await phaseCatalog.load();
  const empty = phaseCatalog.CATALOG_YEARS.filter(year => !Array.isArray(loaded[year]) || !loaded[year].length);
  if (empty.length) refuse(`phase catalog has no entries for ${empty.join(', ')}`);
  return loaded;
}

async function liveState(crosswalk) {
  const projectIds = [...new Set([...crosswalk.values()].map(String))];
  const { items } = await projectsRepository.listVisible(systemAccess(), {});
  const works = new Map();
  const markers = new Map();
  const commentPeriods = new Map();
  for (const id of projectIds) {
    works.set(id, await worksRepository.listByProject(id));
    const marker = await worksRepository.get(id, OVERRIDE_MARKER_ID);
    if (marker && marker.deleted !== true) markers.set(id, marker);
    commentPeriods.set(id, await commentPeriodsRepository.listEveryByProject(id, systemAccess()));
  }
  const catalog = await listsRepository.readWorksCatalog();
  if (!catalog) refuse('no works catalog stored');
  return {
    rows: new Map(items.map(row => [String(row.id), row])), works, markers, commentPeriods, catalog,
    phaseCatalog: await phasesOf(), sheetProjectIds: await worksRepository.liveProjectIds({ owner: 'sheet' })
  };
}

/** Resolves 1 on a failing count, else 0; throws on a refusal. @param {object} [deps] test seam {state, write, endpoint, now} */
async function run(argv, deps = {}) {
  if (deps.endpoint && !deps.state) refuse('a test endpoint needs a test state');
  const write = deps.write || (line => process.stdout.write(`${line}\n`));
  const o = optionsOf(argv, deps.endpoint);
  const { keys, recipient, extract, extractSha256, crosswalk } = openInputs(o);
  const state = await (deps.state || liveState)(crosswalk);
  const at = (deps.now || new Date()).toISOString();
  const { counts, items } = parityOf({ extract, crosswalk, ...state, at });
  const { blob, sha256 } = writeReport({ kind: REPORT_PURPOSE, extractSha256, at, counts, items }, { keys, recipient, outDir: o['out-dir'] });
  COUNTS.forEach(name => write(`${name}=${counts[name]}`));
  write(`reportSha256=${sha256}`);
  write(`blob=${blob}`);
  return FAILING.some(name => counts[name] > 0) ? 1 : 0;
}

module.exports = { run };

if (require.main === module) {
  run(process.argv.slice(2)).then(code => { process.exitCode = code; }, (err) => {
    logger.error(`[business-works-parity] ${err.refused ? 'refused: ' : ''}${err.message}`);
    process.exitCode = err.refused ? 2 : 1;
  });
}
