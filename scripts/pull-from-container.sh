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
# against the remote's md5 of the original. Re-running resumes — a part that already matches is not
# fetched again.
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
PARTS=$(mktemp -d)
trap 'rm -rf "$PARTS"' EXIT

echo "remote: splitting $REMOTE into $PART_SIZE parts under $WORK"
# `-a 3` for suffix headroom: the default of 2 stops at 676 parts with "output file suffixes
# exhausted", which on a big file arrives as a truncated pull rather than an obvious error.
"${SSH[@]}" "set -e; rm -rf '$WORK'; mkdir -p '$WORK'; cd '$WORK';
             split -a 3 -b '$PART_SIZE' '$REMOTE' part-; md5sum part-* > parts.md5;
             md5sum '$REMOTE' | cut -d' ' -f1 > whole.md5"

"${SSH[@]}" "cat '$WORK/parts.md5'" > "$PARTS/parts.md5"
WHOLE=$("${SSH[@]}" "cat '$WORK/whole.md5'" | tr -d '[:space:]')
echo "remote: $(wc -l < "$PARTS/parts.md5") parts, whole md5 $WHOLE"

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
  echo "some parts never matched after 5 tries; nothing assembled, $WORK left in place to retry"
  exit 1
fi

# `part-*` globs in lexical order, which is the order `split` wrote them in.
cat "$PARTS"/part-* > "$DEST"
got=$(md5sum "$DEST" | cut -d' ' -f1)
if [ "$got" != "$WHOLE" ]; then
  echo "assembled md5 $got does not match the remote's $WHOLE — $WORK left in place"
  exit 1
fi

"${SSH[@]}" "rm -rf '$WORK'"
echo "pulled $DEST ($(stat -c %s "$DEST") bytes), md5 $got matches the container's"
