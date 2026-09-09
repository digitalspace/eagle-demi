#!/usr/bin/env bash
set -euo pipefail

# Does this branch ask search for a different set of fields than its base does?
# Details: docs/ci-search-guards.md.

usage() {
  cat <<'EOF'
Usage: scripts/search-select-changed.sh <base-ref>

Prints `changed` or `unchanged` on stdout, and names each differing constant on stderr.

Compares the VALUES of DOCUMENT_SELECT, PROJECT_SELECT and CHUNK_SELECT in
src/search/ai-search.js between the merge base with <base-ref> and the working tree.
CHUNK_SELECT may be absent on either side; absent on both is not a change.

A diff of the source lines cannot answer this: every constant is a multi-line string
concatenation, so widening one edits a continuation line that carries no `_SELECT`
token — which is exactly the shape of the 2026-09-08 outage commit.

The values are read with a regex over the whole file, not by requiring the module:
the base copy comes out of `git show` with no package tree around it, and the job
that runs this installs no dependencies.

Exit codes: 0 answered, 1 bad usage or the comparison could not be made.
EOF
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  # An empty base ref compared nothing. Exiting 0 on it would read as "no select changed".
  '') echo "❌ no base ref — nothing was compared." >&2; usage >&2; exit 1 ;;
esac

[ $# -eq 1 ] || { usage; exit 1; }

BASE_REF="$1"
SOURCE='src/search/ai-search.js'

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

[ -f "$SOURCE" ] || { echo "❌ $SOURCE is missing from the working tree" >&2; exit 1; }

# Three dots in spirit: the base branch moving on is not this branch changing a select.
BASE_COMMIT=$(git merge-base "$BASE_REF" HEAD 2>/dev/null || echo "$BASE_REF")

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# A base that does not carry the file yet reads as "no constants", so every constant this branch
# has counts as added.
git show "$BASE_COMMIT:$SOURCE" > "$WORK/base.js" 2>/dev/null || : > "$WORK/base.js"

DIFF=$(node -e '
const fs = require("fs");
const NAMES = ["DOCUMENT_SELECT", "PROJECT_SELECT", "CHUNK_SELECT"];
const DECL = /\b(?:const|let|var)\s+(DOCUMENT_SELECT|PROJECT_SELECT|CHUNK_SELECT)\s*=\s*([^;]*);/g;
const STRING = /(["\x27])(?:\\.|(?!\1)[^\\])*\1/g;

// A declaration spans lines and concatenates quoted parts, so take the whole statement and join
// its string literals back into the value the code actually sends.
function valuesIn(source) {
  const found = {};
  for (const m of source.matchAll(DECL)) {
    const parts = m[2].match(STRING);
    found[m[1]] = parts
      ? parts.map((p) => p.slice(1, -1)).join("")
      : m[2].replace(/\s+/g, " ").trim();
  }
  return found;
}

const base = valuesIn(fs.readFileSync(process.argv[1], "utf8"));
const head = valuesIn(fs.readFileSync(process.argv[2], "utf8"));
for (const name of NAMES) {
  const before = name in base ? base[name] : "(absent)";
  const after = name in head ? head[name] : "(absent)";
  if (before === after) continue;
  process.stdout.write(`${name} was: ${before}\n`);
  process.stdout.write(`${name} now: ${after}\n`);
}
' "$WORK/base.js" "$SOURCE")

if [ -n "$DIFF" ]; then
  echo "$SOURCE selects different fields than $BASE_REF:" >&2
  echo "$DIFF" | sed 's/^/  /' >&2
  echo "changed"
else
  echo "unchanged"
fi
