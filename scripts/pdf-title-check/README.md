# PDF title pass rate

Measures how many sample PDFs make it through the title pipeline. Run it on a folder of real PDFs before each rollout of `pdf-title/`.

For each PDF in the folder, it:

1. Runs `set_title` from `pdf-title/titler.py` twice: once with an ASCII title, once with a non-ASCII one.
2. Runs the API side on each titled output, the same way the API does it. `readOriginal` (`src/helpers/pdf-original.js`) reads the original bytes. Then `checkTail` (`src/helpers/pdf-tail.js`) checks the bytes the titler added, using those facts.
3. Compares the facts the reader found (`root`, `info`, `metadata`, `prev`, `size`) with what pikepdf sees and with the numbers the titler wrote from.

Sample PDFs are never committed. Keep them outside the repo.

## Run

From the repo root, with the pinned versions in `pdf-title/requirements.txt` and Node 22 or later:

```sh
pip install -r pdf-title/requirements.txt
python3 scripts/pdf-title-check/pass_rate.py <folder of PDFs> --csv <results.csv>
```

`--csv` writes one row per file: titler result per title, the reader's result, the tail check result per title, and fact differences. `--node` picks the Node binary. The Node side needs no packages beyond the repo's own source.

Exit code: 0 when every check passes, 1 when a check fails, 2 when the run itself breaks.

A check fails when:

- the reader or the tail check refuses any output of a titler-writable file, or
- the reader throws on any file.

## Acceptance

A rollout goes ahead when the summary shows all of these:

- `passes` equals `titled outputs checked`, so no `refused:` lines.
- `failing` and `reader exceptions` are 0.
- `encrypted read as original-encrypted` equals `encrypted`.
- `facts equal` equals `facts compared with pikepdf and titler`, apart from `facts differ: size-vs-pikepdf`. On some files qpdf creates objects in memory that are not in the file, so pikepdf counts a higher size than the file has. Look at each such file in the CSV. The reader's size must still match the titler's, so no `facts differ: size-vs-titler` line may appear.

Reference run, on 91 sample PDFs taken from the test environment:

| Line | Count |
|---|---|
| files | 91 |
| titler-writable | 61 |
| titled outputs checked | 122 |
| passes | 122 |
| not writable: encrypted | 29 |
| not writable: titler-skip:signed | 1 |
| facts compared with pikepdf and titler | 62 |
| facts equal | 59 |
| facts differ: size-vs-pikepdf | 3 |
| encrypted read as original-encrypted | 29 |
| reader exceptions | 0 |
| failing | 0 |

Tests: `python3 -m pytest pdf-title/test_pass_rate.py`.
