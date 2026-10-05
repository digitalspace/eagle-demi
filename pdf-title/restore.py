"""Undo a title update: cut a titled PDF back to its recorded original and prove it by hash.

The titler only appends, so the original is the first `originalLength` bytes. Nothing is returned
or written unless those bytes hash to `originalSha256`.

    python3 pdf-title/restore.py --file titled.pdf --length N --sha256 HEX --out original.pdf
    python3 pdf-title/restore.py --id DOC_ID [--project PROJECT_ID] [--live]

`--id` restores the stored object through the DEMI lease API, the same flow as `run.py`, with
DEMI_API_URL and DEMI_API_KEY set. Without `--live` it only says what it would do.
"""

import argparse
import hashlib
import re
import sys

_SHA256_HEX = re.compile(r"[0-9a-f]{64}")


class Refused(Exception):
    """The bytes cannot be proved to be the original. The message is the reason."""


def restore(data: bytes, original_length, original_sha256) -> bytes:
    """Return the first `original_length` bytes of `data`, or raise Refused."""
    if original_length is None:
        raise Refused("record has no originalLength")
    if original_sha256 is None:
        raise Refused("record has no originalSha256")
    # bool is an int subclass; True would otherwise read as length 1.
    if isinstance(original_length, bool) or not isinstance(original_length, int) or original_length < 1:
        raise Refused(f"originalLength is not a positive integer: {original_length!r}")
    expected = str(original_sha256).lower()
    if not _SHA256_HEX.fullmatch(expected):
        raise Refused("originalSha256 is not a 64-character hex sha256")
    if not data:
        raise Refused("input is empty")
    if len(data) < original_length:
        raise Refused(f"input is {len(data)} bytes, shorter than originalLength {original_length}")

    original = data[:original_length]
    actual = hashlib.sha256(original).hexdigest()
    if actual != expected:
        raise Refused(f"sha256 of the first {original_length} bytes is {actual}, record says {expected}")
    return original


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Restore the original PDF from a titled file.")
    parser.add_argument("--file", help="titled PDF to read")
    parser.add_argument("--length", type=int, help="recorded originalLength (with --file)")
    parser.add_argument("--sha256", help="recorded originalSha256 (with --file)")
    parser.add_argument("--out", help="path for the original; must not exist yet (with --file)")
    parser.add_argument("--id", help="document id: restore its stored object through the DEMI API")
    parser.add_argument("--project", help="the document's project id (with --id)")
    parser.add_argument("--live", action="store_true", help="write (with --id); without it, write nothing")
    parser.add_argument("--timeout", type=int, default=60, help="seconds per request (with --id)")
    args = parser.parse_args(argv)
    if bool(args.file) == bool(args.id):
        parser.error("give exactly one of --file or --id")
    if args.id:
        if args.timeout < 1:
            parser.error("--timeout must be 1 or more")
        return _restore_by_id(args)
    if args.length is None or not args.sha256 or not args.out:
        parser.error("--file needs --length, --sha256 and --out")

    with open(args.file, "rb") as f:
        data = f.read()
    try:
        original = restore(data, args.length, args.sha256)
    except Refused as refused:
        print(f"refused: {refused}", file=sys.stderr)
        return 1
    # "xb" never overwrites, so a wrong --out cannot clobber the titled file or anything else.
    try:
        with open(args.out, "xb") as f:
            f.write(original)
    except FileExistsError:
        print(f"refused: {args.out} already exists", file=sys.stderr)
        return 1
    print(f"restored {len(original)} bytes to {args.out}, sha256 {args.sha256.lower()}")
    return 0


def _restore_by_id(args) -> int:
    # Imported here so --file keeps working offline without the titler's PDF libraries.
    import run

    run.configure_logging()
    client = run.client_from_env(args.timeout)
    if client is None:
        return 2
    row = {"id": args.id, "projectId": args.project, "mode": "restore"}
    if not args.live:
        run.log_row(args.id, "restore", "dry-run", "would restore; add --live to write")
        return 0
    return 0 if run.process(client, row, want="restore") == "restored" else 1


if __name__ == "__main__":
    sys.exit(main())
