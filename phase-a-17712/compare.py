#!/usr/bin/env python3
"""Compare runner results row by row and write table.json + rows.jsonl.

usage: compare.py <corpus.jsonl> <results-dir> <out-dir>

<results-dir> holds, per runner (bash52, bash53, obash, addon), one or more
`<runner>.<n>.jsonl` files (repeat runs). A row's observed outputs per runner
are the set over its runs, each normalized: pids (4+ digit numbers), the
row's working directory and mktemp names, and a diagnostic's `NAME: line N: `
prefix. Target: the output both Bash versions give; where they differ, 5.3's. The
session API (addon) is held to `bash -c` (bash52c/bash53c), since Shell::run
runs each call with `-c` semantics; obash reading stdin to the stdin oracle
(bash52/bash53). A row matches when the runner gave the target in every run;
`flaky` when some runs did; differs otherwise. 52/53 differ when no run of
one equals a run of the other.
"""
import collections
import glob
import json
import os
import re
import sys

PID = re.compile(r"(?<![\w.])\d{4,}(?![\w.])")
PREFIX = re.compile(r"^(?:[^\s:]+: )?(?:line \d+: )", re.M)
TMP = re.compile(r"/mnt/nvme/sami/scratch/SignalDeathReport/Port17712-2/rows/[\w.-]+")


def norm(rec):
    if rec is None:
        return None
    out = rec.get("output", "")
    out = TMP.sub("<TMP>", out)
    out = PREFIX.sub("SH: ", out)
    out = PID.sub("<N>", out)
    return json.dumps([rec.get("exit"), bool(rec.get("timed_out")), out])


RUNNERS = ("bash52", "bash53", "bash52c", "bash53c", "obash", "addon")


def classify(o, runner, old, new):
    """`runner` against the Bash pair `old` (5.2.21) and `new` (5.3.20)."""
    got, b52, b53 = o.get(runner, []), set(o.get(old, [])), set(o.get(new, []))
    if not got:
        return "not-run"
    if not b53:
        return "no-oracle"
    hits = [x in b53 for x in got]
    status = "match" if all(hits) else "flaky" if any(hits) else "differs"
    if not (b52 & b53):
        if status != "differs":
            status += "/52-53-differ(=5.3)"
        else:
            status += "/52-53-differ" + ("(=5.2)" if set(got) & b52 else "(=neither)")
    return status


def main():
    corpus, results, outdir = sys.argv[1:4]
    rows = [json.loads(l) for l in open(corpus)]
    obs = collections.defaultdict(lambda: collections.defaultdict(list))
    for path in sorted(glob.glob(os.path.join(results, "*.jsonl"))):
        runner = os.path.basename(path).split(".")[0]
        for line in open(path):
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            obs[rec["id"]][runner].append(norm(rec))
    table = collections.Counter()
    ob_table = collections.Counter()
    by_source = collections.defaultdict(collections.Counter)
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, "rows.jsonl"), "w") as sink:
        for row in rows:
            o = obs[row["id"]]
            status = classify(o, "addon", "bash52c", "bash53c")
            ob_status = classify(o, "obash", "bash52", "bash53")
            table[status] += 1
            by_source[row["source"]][status] += 1
            ob_table[ob_status] += 1
            sink.write(json.dumps({"id": row["id"], "source": row["source"], "status": status, "obash": ob_status,
                                   **{k: sorted(set(o.get(k, []))) for k in RUNNERS}}) + "\n")
    json.dump({"total": len(rows), "status": table, "obash_status": ob_table, "by_source": by_source}, open(os.path.join(outdir, "table.json"), "w"), indent=1)
    print(json.dumps({"total": len(rows), "status": table, "obash_status": ob_table}, indent=1))
    for src, c in sorted(by_source.items()):
        print(f"{src:40s} {dict(c)}")


if __name__ == "__main__":
    main()
