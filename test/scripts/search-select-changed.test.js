'use strict';

/**
 * The PR gate's "did this branch change what search asks for" question, against real git history.
 *
 * The shape that matters is the one the 2026-09-08 outage had: every `*_SELECT` is a multi-line
 * concatenation, so the field that took production down arrived on a continuation line carrying no
 * `_SELECT` token. A gate reading diff lines answers "no" to exactly the change it exists to catch.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runScript } = require('../helpers/stub-http');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'search-select-changed.sh');

const BASE = `'use strict';

const DOCUMENT_SELECT = 'id,displayName,description,' +
  'projectId,read,isPublished,' +
  'documentSource';

const PROJECT_SELECT = 'id,name,' +
  'legacyEagleId,read';

module.exports = { DOCUMENT_SELECT, PROJECT_SELECT };
`;

/** Commit `base`, leave `head` in the working tree, and answer with the repo path. */
function repoWith(base, head) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-select-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });

  git('init', '-q', '-b', 'main', '.');
  git('config', 'user.email', 'ci@example.invalid');
  git('config', 'user.name', 'ci');
  fs.mkdirSync(path.join(dir, 'src', 'search'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'search', 'ai-search.js'), base);
  git('add', '-A');
  git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(dir, 'src', 'search', 'ai-search.js'), head);
  return dir;
}

function run(base, head) {
  const dir = repoWith(base, head);
  return runScript(SCRIPT, ['HEAD'], { cwd: dir }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test('search-select-changed.sh', async (t) => {
  await t.test('sees a field added on a continuation line', async () => {
    const head = BASE.replace("'documentSource';", "'documentSource,fileSize';");
    const result = await run(BASE, head);

    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout.trim(), 'changed');
    assert.match(result.stderr, /DOCUMENT_SELECT now: .*fileSize/);
  });

  await t.test('reads values, so rewrapping the same field list is not a change', async () => {
    const head = BASE.replace(
      "const DOCUMENT_SELECT = 'id,displayName,description,' +\n  'projectId,read,isPublished,' +\n  'documentSource';",
      "const DOCUMENT_SELECT =\n  'id,displayName,' +\n  'description,projectId,' +\n  'read,isPublished,documentSource';"
    );
    assert.notStrictEqual(head, BASE);
    const result = await run(BASE, head);

    assert.strictEqual(result.stdout.trim(), 'unchanged');
  });

  await t.test('a change elsewhere in the file is not a select change', async () => {
    const result = await run(BASE, `${BASE}\nconst MAX_PAGE_ROWS = 500;\n`);
    assert.strictEqual(result.stdout.trim(), 'unchanged');
  });

  await t.test('CHUNK_SELECT counts once it exists, and its absence is not a difference', async () => {
    assert.strictEqual((await run(BASE, BASE)).stdout.trim(), 'unchanged');

    const head = `${BASE}\nconst CHUNK_SELECT = 'id,documentId,' +\n  'pageNumber';\n`;
    const result = await run(BASE, head);
    assert.strictEqual(result.stdout.trim(), 'changed');
    assert.match(result.stderr, /CHUNK_SELECT was: \(absent\)/);
  });
});
