'use strict';

/**
 * Node side of pass_rate.py. Reads JSON lines `{name, original, titled: [{file, title}, ...]}` on
 * stdin and writes one line per input: `{name, facts, tails}` or `{name, exception}`. `facts` is what
 * `readOriginal` returns for the original; `tails` holds `checkTail`'s reason per titled file, null
 * for a pass. Same calls, same order as the API: read the original, then check the bytes after it
 * against the title the file was written with.
 */

const fs = require('fs');
const readline = require('readline');
const { readOriginal } = require('../../src/helpers/pdf-original');
const { checkTail } = require('../../src/helpers/pdf-tail');

async function check({ name, original, titled }) {
  const bytes = fs.readFileSync(original);
  let facts;
  try {
    facts = await readOriginal(async (offset, length) => bytes.subarray(offset, offset + length), bytes.length);
  } catch (err) {
    return { name, exception: err.message };
  }
  const tails = titled.map(({ file, title }) =>
    checkTail(fs.readFileSync(file).subarray(bytes.length), bytes.length, facts, title));
  return { name, facts, tails };
}

(async () => {
  for await (const line of readline.createInterface({ input: process.stdin })) {
    if (line.trim()) process.stdout.write(`${JSON.stringify(await check(JSON.parse(line)))}\n`);
  }
})().catch((err) => {
  process.stderr.write(`${err.stack}\n`);
  process.exitCode = 1;
});
