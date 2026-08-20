#!/usr/bin/env bash
#
# Pull a large file out of an App Service container over the SSH tunnel, and prove it arrived whole.
#
# Two traps make the obvious approaches wrong:
#
#   * `scp` does not work. App Service's SSH has no sftp subsystem, so it fails immediately.
#   * `ssh 'cat big.gz' > local.gz` is worse, because it fails silently. The tunnel drops mid-stream,
#     the redirect keeps whatever arrived, and **ssh still exits 0**. Pulling the 2026-08-20 chunk
#     export that way produced 568 MB of a 992 MB file and reported success.
#
# So: split remotely, pull each part until its md5 matches, assemble, and check the whole file
# against the remote's md5 of the original. Re-running resumes: the remote split and the verified
# local parts both survive until the whole file checks out, so a pull that dies at part 700 of 800
# fetches 100 parts on the retry rather than starting over.
#
# Bring the tunnel up first (see README, "Running anything against the database"):
#
#   az webapp create-remote-connection -g c4b0a8-test-rg -n demi-api-test --port 50123 &
#
# Splitting doubles the file's footprint under /home for the duration; /home has 30 GB.
#
# Usage: scripts/pull-from-container.sh /home/backups/chunks.jsonl.gz ./chunks.jsonl.gz [port]
#        CONTAINER_SSH_PASSWORD=... PART_SIZE=200M scripts/pull-from-container.sh ...
set -euo pipefail

REMOTE=${1:?remote path inside the container}
DEST=${2:?local destination path}
PORT=${3:-50123}
PASS=${CONTAINER_SSH_PASSWORD:-'Docker!'}
PART_SIZE=${PART_SIZE:-100M}

# `-c aes256-cbc -m hmac-sha1`: App Service offers only legacy CBC ciphers, which OpenSSH 9+ disables
# by default. `-n` is not optional either — without it ssh reads the `while read` loop's stdin below
# and swallows the manifest after the first part.
#
# `PULL_SSH_CMD` swaps the transport for anything that runs its single string argument as a shell
# command, which is how `test/scripts/pull-from-container.test.js` exercises the retry loop without
# a container.
if [ -n "${PULL_SSH_CMD:-}" ]; then
  read -r -a SSH <<< "$PULL_SSH_CMD"
else
  SSH=(sshpass -p "$PASS" ssh -n
       -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR
       -c aes256-cbc -m hmac-sha1 -p "$PORT" root@127.0.0.1)
fi

WORK="/home/.pull-$(basename "$REMOTE")"
# Both sides survive the run on purpose: a pull that dies at part 700 of 800 is exactly the one
# worth resuming, and neither side is thrown away until the assembled md5 matches.
PARTS="$DEST.parts"
mkdir -p "$PARTS"

echo "remote: preparing $REMOTE in $PART_SIZE parts under $WORK"
# Split only when there is nothing usable there already — and re-split when the source has changed
# underneath a previous run, which is the one way stale parts could assemble into a file that never
# existed. `-a 3` for suffix headroom: the default of 2 stops at 676 parts with "output file
# suffixes exhausted", which on a big file arrives as a truncated pull rather than an obvious error.
"${SSH[@]}" "set -e; mkdir -p '$WORK'; cd '$WORK';
             now=\$(md5sum '$REMOTE' | cut -d' ' -f1);
             if [ ! -s parts.md5 ] || [ \"\$(cat whole.md5 2>/dev/null)\" != \"\$now\" ]; then
               rm -f part-*; split -a 3 -b '$PART_SIZE' '$REMOTE' part-;
               md5sum part-* > parts.md5; echo \"\$now\" > whole.md5;
             fi"

"${SSH[@]}" "cat '$WORK/parts.md5'" > "$PARTS/parts.md5"
WHOLE=$("${SSH[@]}" "cat '$WORK/whole.md5'" | tr -d '[:space:]')
NPARTS=$(grep -c . "$PARTS/parts.md5" || true)

# The manifest arrives down the same stream as everything else, so it can be truncated the same way
# — and a manifest cut to nothing lists no parts, which would otherwise walk into `cat part-*` with
# no matches and report a glob error instead of the real problem.
if [ "$NPARTS" -eq 0 ] || [ -z "$WHOLE" ]; then
  echo "the manifest came back empty — the transport truncated it. Nothing pulled; re-run."
  exit 1
fi
echo "remote: $NPARTS parts, whole md5 $WHOLE"

failed=0
while read -r sum name; do
  for _ in 1 2 3 4 5; do
    if [ -f "$PARTS/$name" ] && [ "$(md5sum "$PARTS/$name" | cut -d' ' -f1)" = "$sum" ]; then
      break
    fi
    "${SSH[@]}" "cat '$WORK/$name'" > "$PARTS/$name" || true
  done
  if [ "$(md5sum "$PARTS/$name" 2>/dev/null | cut -d' ' -f1)" = "$sum" ]; then
    echo "ok   $name"
  else
    echo "FAIL $name"
    failed=1
  fi
done < "$PARTS/parts.md5"

if [ "$failed" != 0 ]; then
  echo "some parts never matched after 5 tries; nothing assembled. Re-run to resume — $WORK and"
  echo "$PARTS are both kept, and the parts that did verify are not fetched again."
  exit 1
fi

# Assembled beside the destination, never AT it: a mismatch here is the truncated-file failure this
# script exists to prevent, and leaving a short file at $DEST would hand back exactly what it is
# supposed to catch. $DEST only ever appears once it is proven whole.
# `part-*` globs in lexical order, which is the order `split` wrote them in.
cat "$PARTS"/part-* > "$DEST.partial"
got=$(md5sum "$DEST.partial" | cut -d' ' -f1)
if [ "$got" != "$WHOLE" ]; then
  rm -f "$DEST.partial"
  echo "assembled md5 $got does not match the remote's $WHOLE — nothing written to $DEST."
  echo "The parts verified individually, so the manifest itself is suspect: rm -rf $PARTS $WORK and re-run."
  exit 1
fi

mv "$DEST.partial" "$DEST"
rm -rf "$PARTS"
"${SSH[@]}" "rm -rf '$WORK'"
echo "pulled $DEST ($(stat -c %s "$DEST") bytes), md5 $got matches the container's"
