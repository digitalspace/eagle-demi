#!/usr/bin/env node
// Ratchet for ESLint size rules: offenders recorded in a baseline may shrink, never grow, and none may be added.
// Usage: eslint-size-freeze.cjs --check|--tighten|--init api|frontend. --init only when no baseline exists.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const REPO = path.resolve(__dirname, '..');
const WORKSPACES = {
  api: { dir: '.', testFiles: ['test/**'] },
  frontend: { dir: 'frontend', testFiles: ['src/**/*.{test,spec}.{ts,tsx}', 'src/test-*.{ts,tsx}'] },
};
const RULES = {
  'max-lines': ['error', { max: 400 }],
  'max-lines-per-function': ['error', { max: 150, IIFEs: true }],
  complexity: ['error', { max: 20 }],
};
// A describe() callback counts as one function, so the function rule would only measure the wrapper.
const TEST_RULES = {
  'max-lines': ['error', { max: 800 }],
  'max-lines-per-function': 'off',
};

// Inline config is off so an eslint-disable comment cannot hide an offender.
async function measure({ dir, testFiles }) {
  const cwd = path.join(REPO, dir);
  const { ESLint } = createRequire(path.join(cwd, 'package.json'))('eslint');
  const eslint = new ESLint({
    cwd,
    allowInlineConfig: false,
    ruleFilter: ({ ruleId }) => ruleId in RULES,
    overrideConfig: [
      { files: ['**/*.{js,cjs,mjs,ts,tsx}'], rules: RULES },
      { files: testFiles, rules: TEST_RULES },
    ],
  });
  const current = {};
  for (const result of await eslint.lintFiles(['.'])) {
    const file = path.relative(cwd, result.filePath);
    for (const msg of result.messages) {
      if (msg.fatal) throw new Error(`${file}: ${msg.message}`);
      const match = /too many lines \((\d+)\)|complexity of (\d+)/.exec(msg.message);
      if (!match) throw new Error(`${file}: cannot read a value from "${msg.message}"`);
      current[file] ??= {};
      current[file][msg.ruleId] ??= [];
      current[file][msg.ruleId].push(Number(match[1] ?? match[2]));
    }
    for (const values of Object.values(current[file] ?? {})) values.sort((a, b) => b - a);
  }
  return current;
}

// Values are compared largest to largest, so renaming a function or moving it within its file needs no baseline edit.
function compare(baseline, current) {
  const next = {};
  const problems = [];
  const files = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  for (const file of files) {
    for (const rule of Object.keys(RULES)) {
      const allowed = baseline[file]?.[rule] ?? [];
      const values = current[file]?.[rule] ?? [];
      const kept = [];
      for (let i = 0; i < Math.max(allowed.length, values.length); i++) {
        const ceiling = allowed[i];
        const value = values[i];
        if (ceiling === undefined) problems.push(`new ${file} ${rule}: ${value} is over the limit`);
        else if (value === undefined) problems.push(`stale ${file} ${rule}: ceiling ${ceiling} has no offender, run --tighten`);
        else if (value > ceiling) problems.push(`grown ${file} ${rule}: ${value} is over ceiling ${ceiling}`);
        else if (value < ceiling) problems.push(`stale ${file} ${rule}: ${value} is under ceiling ${ceiling}, run --tighten`);
        if (ceiling !== undefined && value !== undefined) kept.push(Math.min(ceiling, value));
      }
      if (kept.length) {
        next[file] ??= {};
        next[file][rule] = kept;
      }
    }
  }
  return { next, problems };
}

function writeBaseline(file, data) {
  const lines = Object.keys(data)
    .sort()
    .map((key) => `  ${JSON.stringify(key)}: ${JSON.stringify(data[key])}`);
  fs.writeFileSync(file, `{\n${lines.join(',\n')}\n}\n`);
}

async function main(mode, name) {
  const workspace = WORKSPACES[name];
  if (!workspace || !['--init', '--check', '--tighten'].includes(mode)) {
    throw new Error('usage: --init|--check|--tighten api|frontend');
  }
  const baselinePath = path.join(__dirname, `eslint-size-freeze.${name}.json`);
  const hasBaseline = fs.existsSync(baselinePath);
  if (mode === '--init' && hasBaseline) throw new Error(`${baselinePath} exists; --init would raise ceilings`);
  if (mode !== '--init' && !hasBaseline) throw new Error(`${baselinePath} is missing`);
  const current = await measure(workspace);
  if (mode === '--init') {
    writeBaseline(baselinePath, current);
    return 0;
  }
  const { next, problems } = compare(JSON.parse(fs.readFileSync(baselinePath, 'utf8')), current);
  if (mode === '--tighten') {
    writeBaseline(baselinePath, next);
    return 0;
  }
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  return problems.length ? 1 : 0;
}

main(process.argv[2], process.argv[3]).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  },
);
