#!/usr/bin/env python3
"""Pass rate of the PDF title pipeline on a folder of sample PDFs. How to run it: README.md here."""

import argparse
import csv
import io
import json
import logging
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "pdf-title"))

import pikepdf  # noqa: E402
from pypdf import PdfReader  # noqa: E402

import titler  # noqa: E402
from titler import set_title  # noqa: E402

TITLES = ("Plain title", "Rapport d'évaluation – Faune ✓")
CSV_FIELDS = ("file", "bytes", "class", "titler", "reader", "tails", "facts_diff", "pikepdf_error")


def _ref(obj):
    return list(obj.objgen) if obj is not None and obj.is_indirect else None


def pike_facts(data):
    """What qpdf, through pikepdf, sees as the original's root, info, metadata and object numbers."""
    try:
        with pikepdf.open(io.BytesIO(data)) as pdf:
            trailer = pdf.trailer
            return {"encrypted": pdf.is_encrypted, "root": _ref(trailer.get("/Root")),
                    "info": _ref(trailer.get("/Info")), "metadata": _ref(pdf.Root.get("/Metadata")),
                    "size": int(trailer.Size),
                    # Scalar objects come back as plain Python values without objgen.
                    "max_object": max((o.objgen[0] for o in pdf.objects if hasattr(o, "objgen")), default=0)}
    except Exception as exc:  # pikepdf raises many types for malformed or locked input
        return {"error": repr(exc)[:200]}


def titler_view(data):
    """The numbers the titler writes from (same private helpers), or None when pypdf cannot read it."""
    try:
        reader = PdfReader(io.BytesIO(data), strict=False)
        if reader.is_encrypted:
            return None
        found = titler._STARTXREF.findall(data)
        root = reader.trailer.raw_get("/Root")
        info = titler._info_ref(reader)
        return {"prev": int(found[-1]) if found else None, "size": titler._next_free_number(reader),
                "root": [root.idnum, root.generation], "info": list(info) if info else None}
    except Exception:  # pypdf raises many types for malformed input
        return None


def compare_facts(facts, pike, view):
    """Field names where the reader's facts differ from pikepdf or from the titler's own view."""
    diffs = [f for f in ("root", "info", "metadata") if facts.get(f) != pike.get(f)]
    diffs += [f"{f}-vs-titler" for f in ("prev", "size", "root", "info") if facts.get(f) != view.get(f)]
    # pikepdf also counts objects qpdf creates in memory, so this one can differ on a sound reader.
    if facts.get("size") != max(pike["size"], pike["max_object"] + 1):
        diffs.append("size-vs-pikepdf")
    return diffs


def classify(titler_results, pike):
    if "ready" in titler_results:
        return "writable"
    if "skip:encrypted" in titler_results or pike.get("encrypted"):
        return "encrypted"
    return f"titler-{titler_results[0]}"


def broken(message):
    """The run itself failed, as opposed to a check: exit 2."""
    print(message, file=sys.stderr)
    raise SystemExit(2)


def run_node(entries, node):
    """`check.js` over every entry; one result per name."""
    stdin = "".join(json.dumps(e) + "\n" for e in entries)
    proc = subprocess.run([node, str(HERE / "check.js")], input=stdin, capture_output=True, text=True,
                          check=False)
    if proc.returncode != 0:
        broken(f"check.js exited {proc.returncode}: {proc.stderr.strip()[-2000:]}")
    results = {r["name"]: r for r in map(json.loads, proc.stdout.splitlines())}
    missing = [e["name"] for e in entries if e["name"] not in results]
    if missing:
        broken(f"check.js gave no result for {len(missing)} file(s), first {missing[0]}")
    return results


def build_rows(samples, out_dir, node):
    rows, entries = [], []
    for path in samples:
        data = path.read_bytes()
        titled, results = [], []
        for k, title in enumerate(TITLES):
            res = set_title(data, title)
            results.append("ready" if res.status == "ready" else f"skip:{res.reason}")
            if res.data is not None:
                file = Path(out_dir) / f"{len(entries)}.{k}.pdf"
                file.write_bytes(res.data)
                titled.append(str(file))
        pike = pike_facts(data)
        rows.append({"file": path.name, "bytes": len(data), "class": classify(results, pike),
                     "titler": results, "pike": pike, "view": titler_view(data)})
        entries.append({"name": str(len(entries)), "original": str(path), "titled": titled})
    checked = run_node(entries, node)
    for i, row in enumerate(rows):
        result = checked[str(i)]
        count = len(entries[i]["titled"])
        if "exception" in result:
            row["reader"] = f"exception: {result['exception']}"
            row["tails"] = ["reader-exception"] * count
            row["facts_diff"] = []
            continue
        facts = result["facts"]
        row["reader"] = facts.get("error", "facts")
        row["tails"] = result["tails"]
        if "error" in facts:
            row["facts_diff"] = []
        elif "error" in row["pike"] or row["view"] is None:
            row["facts_diff"] = ["not-compared"]
        else:
            row["facts_diff"] = compare_facts(facts, row["pike"], row["view"])
    return rows


def tally(rows):
    """Summary as ordered (label, count) pairs, and the number of failures that set the exit code."""
    writable = [r for r in rows if r["class"] == "writable"]
    tails = [t for r in writable for t in r["tails"]]
    compared = [r for r in rows if r["reader"] == "facts" and r["facts_diff"] != ["not-compared"]]
    encrypted = [r for r in rows if r["class"] == "encrypted"]
    exceptions = [r for r in rows if r["reader"].startswith("exception")]
    # A writable file with any refused output fails the run; so does an exception on any file.
    failing = len({r["file"] for r in writable if any(t is not None for t in r["tails"])}
                  | {r["file"] for r in exceptions})
    summary = [("files", len(rows)),
               ("titler-writable", len(writable)),
               ("titled outputs checked", len(tails)),
               ("passes", sum(t is None for t in tails))]
    summary += [(f"refused: {reason}", n) for reason, n in sorted(Counter(t for t in tails if t).items())]
    summary += [(f"not writable: {cls}", n)
                for cls, n in sorted(Counter(r["class"] for r in rows if r["class"] != "writable").items())]
    summary += [("facts compared with pikepdf and titler", len(compared)),
                ("facts equal", sum(not r["facts_diff"] for r in compared))]
    summary += [(f"facts differ: {f}", n) for f, n in sorted(Counter(f for r in compared for f in r["facts_diff"]).items())]
    summary += [("encrypted", len(encrypted)),
                ("encrypted read as original-encrypted", sum(r["reader"] == "original-encrypted" for r in encrypted)),
                ("reader exceptions", len(exceptions)),
                ("failing", failing)]
    return summary, failing


def format_table(summary):
    width = max(len(label) for label, _ in summary)
    return "\n".join(f"{label:<{width}}  {n:>6}" for label, n in summary)


def write_csv(rows, path):
    with open(path, "w", newline="", encoding="utf-8") as f:
        out = csv.DictWriter(f, fieldnames=CSV_FIELDS, extrasaction="ignore")
        out.writeheader()
        for row in rows:
            out.writerow({**row, "titler": "|".join(row["titler"]),
                          "tails": "|".join(t or "pass" for t in row["tails"]),
                          "facts_diff": "|".join(row["facts_diff"]),
                          "pikepdf_error": row["pike"].get("error", "")})


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("samples", type=Path, help="folder of sample PDFs (not searched recursively)")
    parser.add_argument("--csv", type=Path, help="write per-file results here")
    parser.add_argument("--node", default="node", help="Node binary (default: node on PATH)")
    args = parser.parse_args(argv)
    samples = sorted(p for p in args.samples.iterdir() if p.is_file() and p.suffix.lower() == ".pdf")
    if not samples:
        parser.error(f"no .pdf files in {args.samples}")
    logging.getLogger("pypdf").setLevel(logging.ERROR)
    with tempfile.TemporaryDirectory() as out_dir:
        rows = build_rows(samples, out_dir, args.node)
    summary, failing = tally(rows)
    print(format_table(summary))
    if args.csv:
        write_csv(rows, args.csv)
    return 1 if failing else 0


if __name__ == "__main__":
    sys.exit(main())
